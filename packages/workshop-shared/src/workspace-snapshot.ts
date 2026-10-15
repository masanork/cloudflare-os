/** Maximum serialized portable workspace archive, before Vault encryption. */
export const WORKSPACE_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024 - 29;

/** A tagged value that cannot carry an RPC capability or an executable getter. */
export type PortableValue =
  | null
  | boolean
  | number
  | string
  | { type: "bytes" | "date"; value: string }
  | { type: "undefined"; value: null }
  | { type: "array" | "set"; value: PortableValue[] }
  | { type: "object" | "map"; value: [PortableValue, PortableValue][] };

/** Convert persisted values to a bounded, capability-free representation. */
export function encodePortable(value: unknown, depth = 0): PortableValue {
  if (depth > 32) throw new Error("Snapshot nesting limit exceeded.");
  // Reject a single oversized KV value before allocating its tagged/hex representation.
  if (
    (typeof value === "string" && value.length > WORKSPACE_SNAPSHOT_MAX_BYTES) ||
    ((value instanceof Uint8Array || value instanceof ArrayBuffer) &&
      value.byteLength * 2 > WORKSPACE_SNAPSHOT_MAX_BYTES) ||
    (Array.isArray(value) && value.length > 10000) ||
    ((value instanceof Set || value instanceof Map) && value.size > 10000)
  )
    throw new Error("Snapshot value exceeds portable size/count limits.");
  if (value === undefined) return { type: "undefined", value: null };
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Uint8Array)
    return {
      type: "bytes",
      value: Array.from(value, (b) => b.toString(16).padStart(2, "0")).join(""),
    };
  if (value instanceof ArrayBuffer)
    return {
      type: "bytes",
      value: Array.from(new Uint8Array(value), (b) => b.toString(16).padStart(2, "0")).join(""),
    };
  if (value instanceof Date) return { type: "date", value: value.toISOString() };
  const next = (v: unknown) => encodePortable(v, depth + 1);
  if (Array.isArray(value)) {
    if (Object.values(Object.getOwnPropertyDescriptors(value)).some((p) => p.get || p.set))
      throw new Error("Snapshot cannot include executable properties.");
    return { type: "array", value: Array.from(value, next) };
  }
  if (value instanceof Set) return { type: "set", value: [...value].map(next) };
  if (value instanceof Map)
    return { type: "map", value: [...value].map(([key, v]) => [next(key), next(v)]) };
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    if (Object.getOwnPropertySymbols(value).length)
      throw new Error("Snapshot cannot include symbol properties.");
    const fields: [PortableValue, PortableValue][] = [];
    for (const [key, property] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (property.get || property.set)
        throw new Error("Snapshot cannot include executable properties.");
      fields.push([key, next(property.value)]);
    }
    return { type: "object", value: fields };
  }
  throw new Error(
    "Snapshot contains a nonportable capability or value. Reconnect it after restore.",
  );
}

/** Decode a validated portable value, refusing unsafe object keys and malformed tags. */
export function decodePortable(value: PortableValue, depth = 0): unknown {
  if (depth > 32) throw new Error("Snapshot nesting limit exceeded.");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "value")
  )
    throw new Error("Invalid portable value.");
  if (value.type === "undefined" && value.value === null) return undefined;
  if (
    value.type === "bytes" &&
    typeof value.value === "string" &&
    /^(?:[0-9a-f]{2})*$/.test(value.value)
  )
    return Uint8Array.from({ length: value.value.length / 2 }, (_, i) =>
      Number.parseInt((value.value as string).slice(i * 2, i * 2 + 2), 16),
    );
  if (
    value.type === "date" &&
    typeof value.value === "string" &&
    new Date(value.value).toISOString() === value.value
  )
    return new Date(value.value);
  if (!Array.isArray(value.value) || value.value.length > 10000)
    throw new Error("Invalid portable value.");
  const next = (v: PortableValue) => decodePortable(v, depth + 1);
  if (value.type === "array") return value.value.map(next);
  if (value.type === "set") return new Set(value.value.map(next));
  if (value.type === "map")
    return new Map(
      value.value.map((pair) => {
        if (!Array.isArray(pair) || pair.length !== 2) throw new Error("Invalid map entry.");
        return [next(pair[0]), next(pair[1])];
      }),
    );
  if (value.type === "object") {
    const result: Record<string, unknown> = {};
    for (const pair of value.value) {
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        typeof pair[0] !== "string" ||
        ["__proto__", "constructor", "prototype"].includes(pair[0]) ||
        Object.hasOwn(result, pair[0])
      )
        throw new Error("Invalid object key.");
      result[pair[0]] = next(pair[1]);
    }
    return result;
  }
  throw new Error("Invalid portable tag.");
}

/** Portable application storage; includes ordinary SQL tables plus KV data. */
export type WorkspaceStorage = {
  /** User SQL objects, in creation order; excludes Cloudflare internals. */
  schema: { type: string; name: string; sql: string }[];
  /** Table columns and rows. Binary SQL cells use the same portable codec. */
  tables: { name: string; columns: string[]; rows: PortableValue[][]; sequence?: number }[];
  /** KV values; no native serialized capabilities are admitted. */
  kv: [string, PortableValue][];
};

/** A bounded business-data snapshot, without live permissions or callbacks. */
export type WorkspaceSnapshot = {
  /** Stable format identifier. */
  format: "cloudflare-os-workspace";
  /** Snapshot schema version. */
  version: 1;
  /** Claimed source identity, to be bound to the handoff's actual origin in Mikaki. */
  source: { origin: string; workspaceId: string; capturedAt: string };
  /** Workspace title. */
  title: string;
  /** Portable owner-selected business rows from the supervisor. */
  records: [string, PortableValue][];
  /** Each gadget's isolated persisted application state. */
  gadgets: { id: number; state: WorkspaceStorage }[];
};

/** Validate a bounded snapshot before allocating or writing any restore state. */
export function parseWorkspaceSnapshot(text: string): WorkspaceSnapshot {
  if (new TextEncoder().encode(text).length > WORKSPACE_SNAPSHOT_MAX_BYTES)
    throw new Error("Workspace snapshot exceeds 2 MiB.");
  let value: WorkspaceSnapshot;
  try {
    value = JSON.parse(text) as WorkspaceSnapshot;
  } catch {
    throw new Error("Invalid workspace snapshot JSON.");
  }
  if (
    !value ||
    Object.keys(value).toSorted().join(",") !== "format,gadgets,records,source,title,version" ||
    value.format !== "cloudflare-os-workspace" ||
    value.version !== 1 ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    value.title.length > 256 ||
    !value.source ||
    Object.keys(value.source).toSorted().join(",") !== "capturedAt,origin,workspaceId" ||
    typeof value.source.origin !== "string" ||
    new URL(value.source.origin).origin !== value.source.origin ||
    !/^[0-9a-f]{64}$/.test(value.source.workspaceId) ||
    new Date(value.source.capturedAt).toISOString() !== value.source.capturedAt ||
    !Array.isArray(value.records) ||
    value.records.length > 10000 ||
    !Array.isArray(value.gadgets) ||
    value.gadgets.length > 16
  )
    throw new Error("Invalid workspace snapshot.");
  const keys = new Set<string>(),
    ids = new Set<number>();
  for (const pair of value.records) {
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error("Invalid snapshot records.");
    const [key, v] = pair;
    if (typeof key !== "string" || keys.has(key)) throw new Error("Invalid snapshot records.");
    keys.add(key);
    decodePortable(v);
  }
  for (const gadget of value.gadgets) {
    if (
      !gadget ||
      Object.keys(gadget).toSorted().join(",") !== "id,state" ||
      !Number.isSafeInteger(gadget.id) ||
      gadget.id < 0 ||
      ids.has(gadget.id)
    )
      throw new Error("Invalid gadget snapshot.");
    ids.add(gadget.id);
    validateWorkspaceStorage(gadget.state);
  }
  return value;
}

const safeName = (name: unknown): name is string =>
  typeof name === "string" &&
  name.length > 0 &&
  name.length <= 256 &&
  !/^_*cf_|^sqlite_|^__miniflare_/i.test(name) &&
  !name.includes("\0");

/** Validate SQL/KV archive shape without running source SQL. */
export function validateWorkspaceStorage(state: WorkspaceStorage): void {
  if (
    !state ||
    Object.keys(state).toSorted().join(",") !== "kv,schema,tables" ||
    !Array.isArray(state.schema) ||
    state.schema.length > 256 ||
    !Array.isArray(state.tables) ||
    state.tables.length > 128 ||
    !Array.isArray(state.kv) ||
    state.kv.length > 10000
  )
    throw new Error("Invalid storage snapshot.");
  const names = new Set<string>(),
    tables = new Set<string>(),
    keys = new Set<string>();
  for (const entry of state.schema) {
    if (
      !entry ||
      Object.keys(entry).toSorted().join(",") !== "name,sql,type" ||
      !["table", "index", "trigger", "view"].includes(entry.type) ||
      typeof entry.sql !== "string" ||
      !safeName(entry.name) ||
      names.has(entry.name) ||
      !new RegExp("^CREATE\\s+(?:UNIQUE\\s+)?" + entry.type + "\\s", "i").test(entry.sql)
    )
      throw new Error("Invalid SQL schema.");
    names.add(entry.name);
  }
  for (const table of state.tables) {
    if (
      !table ||
      !["columns,name,rows", "columns,name,rows,sequence"].includes(
        Object.keys(table).toSorted().join(","),
      ) ||
      !safeName(table.name) ||
      tables.has(table.name) ||
      !state.schema.some((e) => e.type === "table" && e.name === table.name) ||
      !Array.isArray(table.columns) ||
      !table.columns.length ||
      table.columns.length > 128 ||
      new Set(table.columns).size !== table.columns.length ||
      table.columns.some((c) => typeof c !== "string" || c.includes("\0")) ||
      !Array.isArray(table.rows) ||
      table.rows.length > 10000 ||
      (table.sequence !== undefined &&
        (!Number.isSafeInteger(table.sequence) || table.sequence < 0))
    )
      throw new Error("Invalid SQL table.");
    tables.add(table.name);
    for (const row of table.rows) {
      if (!Array.isArray(row) || row.length !== table.columns.length)
        throw new Error("Invalid SQL row.");
      for (const cell of row) {
        const v = decodePortable(cell);
        if (
          v !== null &&
          typeof v !== "string" &&
          !(v instanceof Uint8Array) &&
          !(
            typeof v === "number" &&
            Number.isFinite(v) &&
            (!Number.isInteger(v) || Number.isSafeInteger(v))
          )
        )
          throw new Error("Nonportable SQL cell.");
      }
    }
  }
  if (state.schema.filter((e) => e.type === "table").length !== tables.size)
    throw new Error("Missing SQL table data.");
  for (const pair of state.kv) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      keys.has(pair[0])
    )
      throw new Error("Invalid KV key.");
    keys.add(pair[0]);
    decodePortable(pair[1]);
  }
}
