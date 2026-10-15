import { expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer";
import type { WorkspaceStorageInspector } from "../src/workspace-storage";
import {
  encodePortable,
  decodePortable,
  type WorkspaceStorage,
} from "@gadgets/workshop-shared/workspace-snapshot";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}
const fixture: WorkspaceStorage = {
  schema: [
    {
      type: "table",
      name: "notes",
      sql: "CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT, content BLOB)",
    },
  ],
  tables: [
    {
      name: "notes",
      columns: ["_rowid_", "id", "body", "content"],
      rows: [[1, 1, "Retained app data", encodePortable(new Uint8Array([0, 1, 255]))]],
    },
  ],
  kv: [["settings", encodePortable({ theme: "dark", at: new Date("2026-10-15T00:00:00.000Z") })]],
};
it("clones a real facet database with both SQL and KV and leaves the original intact", async () => {
  const stub = env.TEST_OVERSEER.getByName("workspace-facet-clone");
  await runInDurableObject(stub, async (_instance, state) => {
    const options = () => ({ class: state.exports.WorkspaceStorageInspector });
    const source = state.facets.get<WorkspaceStorageInspector>("source", options);
    await source.importState(fixture);
    state.facets.clone("source", "snapshot");
    const copy = state.facets.get<WorkspaceStorageInspector>("snapshot", options);
    expect(JSON.parse(await copy.exportState())).toEqual(fixture);
    expect(JSON.parse(await source.exportState())).toEqual(fixture);
    const restored = state.facets.get<WorkspaceStorageInspector>("restored", options);
    await restored.importState(JSON.parse(await copy.exportState()));
    expect(JSON.parse(await restored.exportState())).toEqual(fixture);
    try {
      await restored.importState(fixture);
      throw new Error("expected refusal");
    } catch (e) {
      expect(String(e)).toContain("not empty");
    }
    state.facets.delete("source");
    state.facets.delete("snapshot");
    state.facets.delete("restored");
  });
});
it("restore failure rolls back SQL and KV before the target becomes usable", async () => {
  await runInDurableObject(
    env.TEST_OVERSEER.getByName("workspace-facet-rollback"),
    async (_instance, state) => {
      const target = state.facets.get<WorkspaceStorageInspector>("target", () => ({
        class: state.exports.WorkspaceStorageInspector,
      }));
      try {
        await target.importState({
          ...fixture,
          tables: [
            { ...fixture.tables[0], rows: [...fixture.tables[0].rows, ...fixture.tables[0].rows] },
          ],
        });
        throw new Error("expected refusal");
      } catch (e) {
        expect(String(e)).toContain("UNIQUE constraint");
      }
      expect(JSON.parse(await target.exportState())).toEqual({ schema: [], tables: [], kv: [] });
      state.facets.delete("target");
    },
  );
});
it("preserves generated columns, WITHOUT ROWID tables, indexes, views and historical AUTOINCREMENT sequences", async () => {
  await runInDurableObject(
    env.TEST_OVERSEER.getByName("portable-sql-schema"),
    async (_instance, ctx) => {
      const state: WorkspaceStorage = {
        schema: [
          {
            type: "table",
            name: "notes",
            sql: "CREATE TABLE notes(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT DEFAULT 'WITHOUT ROWID')",
          },
          {
            type: "table",
            name: "derived",
            sql: "CREATE TABLE derived(k TEXT PRIMARY KEY, n INTEGER, doubled INTEGER GENERATED ALWAYS AS (n*2) STORED) WITHOUT ROWID",
          },
          { type: "index", name: "by_title", sql: "CREATE INDEX by_title ON notes(title)" },
          {
            type: "view",
            name: "totals",
            sql: "CREATE VIEW totals AS SELECT doubled FROM derived",
          },
          {
            type: "trigger",
            name: "note_updated",
            sql: "CREATE TRIGGER note_updated AFTER UPDATE ON notes BEGIN UPDATE derived SET n=n+1 WHERE k='x'; END",
          },
        ],
        tables: [
          {
            name: "notes",
            columns: ["_rowid_", "id", "title"],
            rows: [[8, 8, "Saved title"]],
            sequence: 32,
          },
          { name: "derived", columns: ["k", "n"], rows: [["x", 3]] },
        ],
        kv: [],
      };
      const options = () => ({ class: ctx.exports.WorkspaceStorageInspector });
      const first = ctx.facets.get<WorkspaceStorageInspector>("first", options);
      await first.importState(state);
      expect(JSON.parse(await first.exportState())).toEqual(state);
      const second = ctx.facets.get<WorkspaceStorageInspector>("second", options);
      await second.importState(JSON.parse(await first.exportState()));
      expect(JSON.parse(await second.exportState())).toEqual(state);
      ctx.facets.delete("first");
      ctx.facets.delete("second");
    },
  );
});
it("portable storage retains byte/date/map/set values and refuses executable/capability objects", () => {
  const value = {
    date: new Date("2026-10-15T00:00:00.000Z"),
    bytes: new Uint8Array([0, 255]),
    map: new Map([["a", 1]]),
    set: new Set(["x"]),
  };
  expect(decodePortable(encodePortable(value))).toEqual(value);
  expect(() => encodePortable(new Uint8Array(2 * 1024 * 1024))).toThrow("size/count");
  expect(() => encodePortable(Array.from({ length: 10001 }, () => 0))).toThrow("size/count");
  expect(() => encodePortable(() => undefined)).toThrow("nonportable");
  expect(() =>
    encodePortable({
      get value() {
        throw new Error("must not execute");
      },
    }),
  ).toThrow("executable");
  expect(() => decodePortable({ type: "object", value: [["__proto__", "bad"]] })).toThrow(
    "object key",
  );
});
it("refuses data-producing and multi-statement DDL before writing any staging data", async () => {
  await runInDurableObject(
    env.TEST_OVERSEER.getByName("portable-sql-ddl"),
    async (_instance, ctx) => {
      const target = ctx.facets.get<WorkspaceStorageInspector>("target", () => ({
        class: ctx.exports.WorkspaceStorageInspector,
      }));
      const refuse = async (state: WorkspaceStorage) => {
        try {
          await target.importState(state);
          throw new Error("Expected DDL refusal");
        } catch (error) {
          expect(String(error)).toContain("non-data-producing");
        }
        expect(JSON.parse(await target.exportState())).toEqual({ schema: [], tables: [], kv: [] });
      };
      for (const sql of [
        "CREATE TABLE notes AS SELECT 1 AS id",
        "CREATE TABLE notes /* harmless-looking comment */ AS SELECT randomblob(10000000) AS id",
        "CREATE TABLE notes AS WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000) SELECT x AS id FROM n",
        "CREATE TABLE notes(id INTEGER); INSERT INTO notes VALUES(1)",
      ]) {
        await refuse({
          schema: [{ type: "table", name: "notes", sql }],
          tables: [{ name: "notes", columns: ["id"], rows: [] }],
          kv: [],
        });
      }
      for (const entry of [
        {
          type: "index",
          name: "by_body",
          sql: "CREATE INDEX by_body ON notes(body); INSERT INTO notes(id) VALUES(4)",
        },
        {
          type: "view",
          name: "ids",
          sql: "CREATE VIEW ids AS SELECT id FROM notes; INSERT INTO notes(id) VALUES(4)",
        },
        {
          type: "trigger",
          name: "updated",
          sql: "CREATE TRIGGER updated AFTER UPDATE ON notes BEGIN UPDATE notes SET body='x'; END; INSERT INTO notes(id) SELECT CASE WHEN 1 THEN 4 END",
        },
      ]) {
        await refuse({ ...fixture, schema: [...fixture.schema, entry] });
      }
      await target.importState({
        ...fixture,
        schema: [
          ...fixture.schema,
          {
            type: "trigger",
            name: "updated",
            sql: "CREATE TRIGGER updated /* retained comment */ AFTER UPDATE ON notes BEGIN UPDATE notes SET body=CASE WHEN id=1 THEN 'text; -- END' ELSE body END; END",
          },
        ],
      });
      expect(JSON.parse(await target.exportState()).tables[0].rows).toEqual(fixture.tables[0].rows);
      ctx.facets.delete("target");
    },
  );
});
