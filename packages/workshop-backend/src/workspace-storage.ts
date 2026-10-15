import { DurableObject } from "cloudflare:workers";
import {
  encodePortable,
  decodePortable,
  validateWorkspaceStorage,
  WORKSPACE_SNAPSHOT_MAX_BYTES,
  type WorkspaceStorage,
} from "@gadgets/workshop-shared/workspace-snapshot";

const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';

// sqlite_master SQL is untrusted on import. A CREATE TABLE AS SELECT or a second
// statement could write unlisted data before the bounded archive rows are loaded.
const validateDdl = (entry: WorkspaceStorage["schema"][number]) => {
  const tokens = (
    entry.sql.match(
      /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[\p{L}\p{N}\p{M}_$]+|[^\s]/gu,
    ) ?? []
  )
    .filter((t) => !t.startsWith("--") && !t.startsWith("/*"))
    .map((t) => t.toUpperCase());
  if (tokens.at(-1) === ";") tokens.pop();
  const reject = () => {
    throw new Error("Only single, non-data-producing schema DDL is portable.");
  };
  if (entry.type === "table") {
    const name = tokens[2] === "IF" && tokens[3] === "NOT" && tokens[4] === "EXISTS" ? 5 : 2;
    if (tokens[name + 1] !== "(") reject();
  }
  if (entry.type !== "trigger") {
    if (tokens.includes(";")) reject();
    return;
  }
  // Trigger bodies legitimately contain semicolons. Find their closing END,
  // accounting for CASE expressions, and refuse any statement after the body.
  const begin = tokens.indexOf("BEGIN", 3);
  if (begin < 0) reject();
  let cases = 0;
  for (let i = begin + 1; i < tokens.length; i++) {
    if (tokens[i] === "CASE") cases++;
    if (tokens[i] !== "END") continue;
    if (cases) cases--;
    else {
      if (i !== tokens.length - 1) reject();
      return;
    }
  }
  reject();
};

/** Trusted storage inspector, reachable only through supervisor-owned temporary/fresh facets. */
export class WorkspaceStorageInspector extends DurableObject<Cloudflare.Env> {
  /** A capture clone never runs an archived app's scheduled work. */
  alarm(): void {}
  /** Read a frozen facet clone without executing gadget code or exposing native capabilities. */
  exportState(): string {
    return this.ctx.storage.transactionSync(() => {
      // Refuse large databases before reading arbitrary SQL blobs into isolate memory.
      if (this.ctx.storage.sql.databaseSize > 8 * 1024 * 1024)
        throw new Error("Database is too large for a 2 MiB portable snapshot.");
      let used = 0;
      const account = (value: unknown) => {
        used += new TextEncoder().encode(JSON.stringify(value)).length;
        if (used > WORKSPACE_SNAPSHOT_MAX_BYTES)
          throw new Error("Workspace snapshot exceeds 2 MiB.");
      };
      const schema = this.ctx.storage.sql
        .exec<{ type: string; name: string; sql: string }>(
          "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '__miniflare_*' ORDER BY rowid",
        )
        .toArray();
      if (schema.some((entry) => /CREATE\s+VIRTUAL\s+TABLE/i.test(entry.sql)))
        throw new Error("Virtual-table storage is not yet portable.");
      account(schema);
      const tableInfo = this.ctx.storage.sql
        .exec<{ name: string; wr: number }>("PRAGMA table_list")
        .toArray();
      const hasSequence =
        this.ctx.storage.sql
          .exec("SELECT name FROM sqlite_master WHERE name='sqlite_sequence'")
          .toArray().length > 0;
      const tables = schema
        .filter((entry) => entry.type === "table")
        .map((entry) => {
          const info = this.ctx.storage.sql
            .exec<{ name: string; hidden: number }>(`PRAGMA table_xinfo(${quote(entry.name)})`)
            .toArray();
          const columns = info.filter((c) => c.hidden === 0).map((c) => c.name);
          if (!tableInfo.find((t) => t.name === entry.name)?.wr) {
            const rowid = ["_rowid_", "rowid", "oid"].find(
              (name) => !info.some((c) => c.name.toLowerCase() === name),
            );
            if (!rowid) throw new Error("Table hides all rowid aliases.");
            columns.unshift(rowid);
          }
          const cursor = this.ctx.storage.sql.exec(
            `SELECT ${columns.map(quote).join(",")} FROM ${quote(entry.name)}`,
          );
          const rows: WorkspaceStorage["tables"][number]["rows"] = [];
          for (const row of cursor.raw()) {
            const cells = row.map((cell) => encodePortable(cell));
            account(cells);
            rows.push(cells);
            if (rows.length > 10000) throw new Error("Too many SQL rows for a snapshot.");
          }
          const sequence = hasSequence
            ? this.ctx.storage.sql
                .exec<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name=?", entry.name)
                .toArray()[0]?.seq
            : undefined;
          return {
            name: entry.name,
            columns,
            rows,
            ...(sequence === undefined ? {} : { sequence }),
          };
        });
      const kv: WorkspaceStorage["kv"] = [];
      for (const [key, value] of this.ctx.storage.kv.list()) {
        const pair: WorkspaceStorage["kv"][number] = [key, encodePortable(value)];
        account(pair);
        kv.push(pair);
        if (kv.length > 10000) throw new Error("Too many KV values for a snapshot.");
      }
      const result = { schema, tables, kv };
      validateWorkspaceStorage(result);
      const text = JSON.stringify(result);
      if (new TextEncoder().encode(text).length > WORKSPACE_SNAPSHOT_MAX_BYTES)
        throw new Error("Workspace snapshot exceeds 2 MiB.");
      return text;
    });
  }
  /** Restore only into empty staging storage, before any archived gadget code is started. */
  importState(state: WorkspaceStorage): void {
    validateWorkspaceStorage(state);
    for (const entry of state.schema) validateDdl(entry);
    this.ctx.storage.transactionSync(() => {
      if (
        this.ctx.storage.sql
          .exec(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '__miniflare_*'",
          )
          .toArray().length ||
        [...this.ctx.storage.kv.list()].length
      )
        throw new Error("Restore target is not empty.");
      this.ctx.storage.sql.exec("PRAGMA defer_foreign_keys=ON");
      for (const entry of state.schema.filter((e) => e.type === "table"))
        this.ctx.storage.sql.exec(entry.sql);
      for (const table of state.tables)
        for (const row of table.rows)
          this.ctx.storage.sql.exec(
            `INSERT INTO ${quote(table.name)} (${table.columns.map(quote).join(",")}) VALUES (${row.map(() => "?").join(",")})`,
            ...row.map((cell) => decodePortable(cell) as SqlStorageValue),
          );
      for (const table of state.tables)
        if (table.sequence !== undefined) {
          this.ctx.storage.sql.exec("DELETE FROM sqlite_sequence WHERE name=?", table.name);
          this.ctx.storage.sql.exec(
            "INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)",
            table.name,
            table.sequence,
          );
        }
      for (const entry of state.schema.filter((e) => e.type !== "table"))
        this.ctx.storage.sql.exec(entry.sql);
      const actual = this.ctx.storage.sql
        .exec<{ name: string; type: string }>(
          "SELECT name,type FROM sqlite_master WHERE sql IS NOT NULL AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '__miniflare_*'",
        )
        .toArray();
      if (
        actual.length !== state.schema.length ||
        actual.some((e) => !state.schema.some((s) => e.name === s.name && e.type === s.type))
      )
        throw new Error("SQL created undeclared schema objects.");
      for (const [key, value] of state.kv) this.ctx.storage.kv.put(key, decodePortable(value));
    });
  }
}
