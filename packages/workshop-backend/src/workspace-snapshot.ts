import {
  encodePortable,
  decodePortable,
  parseWorkspaceSnapshot,
  WORKSPACE_SNAPSHOT_MAX_BYTES,
  type WorkspaceSnapshot,
  type WorkspaceStorage,
} from "@gadgets/workshop-shared/workspace-snapshot";
import type { OverseerStorage } from "./storage-schema/overseer-storage";
import { OVERSEER_STORAGE_VERSION } from "./storage-schema/overseer-migrations";
import type { WorkspaceStorageInspector } from "./workspace-storage";
import { keyString } from "@gadgets/typed-storage";

const singletons = new Set([
  "version",
  "title",
  "defaultGadgetId",
  "codeVersion",
  "nextGatekeeperId",
  "nextChatId",
  "nextActionId",
  "nextHookId",
  "nextAgentCallId",
]);
const collections = new Set([
  "gadgets",
  "gitObjects",
  "chatMeta",
  "chats",
  "chatCompactions",
  "chatChanges",
  "chatChangeBoundaries",
  "nextChatSequences",
  "chatAttachmentContent",
  "chatModelData",
  "actions",
]);
const retained = (key: string) =>
  singletons.has(key) || (collections.has(key.split(":")[0]!) && key.includes(":"));
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const snapshotOptions = (ctx: DurableObjectState) => ({
  class: ctx.exports.WorkspaceStorageInspector,
});

/** Capture business rows and clone each gadget facet before yielding to storage-export RPC. */
export async function exportWorkspaceSnapshot(
  ctx: DurableObjectState,
  storage: OverseerStorage,
  origin: string,
): Promise<string> {
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("Invalid source origin.");
  const captureOwner = storage.ownerId.get();
  if (!captureOwner || storage.containsRestrictedData.get() || storage.ownerInvitesOnly.get())
    throw new Error("This workspace cannot be copied outside the app.");
  if (
    [...storage.activeAgents.list()].length ||
    [...storage.pendingAgentCalls.list()].length ||
    [...storage.actions.byHistoryFilter.get("pending")].length
  )
    throw new Error("Finish active agents and pending actions before taking a snapshot.");
  if (ctx.storage.kv.get<number[]>("deadWorktreeIds")?.length)
    throw new Error("Private worktree archives need a separate export contract.");
  const gadgets = [...storage.gadgets.list()];
  if (
    gadgets.length > 16 ||
    gadgets.some(
      (g) =>
        g.type !== "gadget" || g.pending || Object.values(g.bindings).some((edge) => edge.pending),
    ) ||
    [...storage.chatMeta.list()].some(
      (chat) => chat.proposedChangeWorkpieces?.length || chat.hasProposedChanges,
    )
  )
    throw new Error("Commit gadget changes before exporting this workspace.");
  const snapshot: WorkspaceSnapshot = {
    format: "cloudflare-os-workspace",
    version: 1,
    source: { origin, workspaceId: ctx.id.toString(), capturedAt: new Date().toISOString() },
    title: storage.title.get(),
    records: [],
    gadgets: [],
  };
  let recordBytes = size(snapshot);
  for (const [key, value] of ctx.storage.kv.list()) {
    if (!retained(key)) continue;
    const pair: WorkspaceSnapshot["records"][number] = [key, encodePortable(value)];
    recordBytes += size(pair) + 1;
    snapshot.records.push(pair);
    if (recordBytes > WORKSPACE_SNAPSHOT_MAX_BYTES)
      throw new Error("Workspace snapshot exceeds 2 MiB.");
  }
  const base = crypto.randomUUID(),
    copies: { id: number; name: string }[] = [];
  const journal = "_vault_snapshot_" + base;
  // A previous interrupted capture can leave private clones. A later capture reaps expired ones.
  // Materialize the cursor before deleting entries and facets; never mutate during iteration.
  const abandoned = Array.from(
    ctx.storage.kv.list<{ at: number; names: string[] }>({ prefix: "_vault_snapshot_" }),
  );
  for (const [key, value] of abandoned) {
    if (value.at < Date.now() - 300_000) {
      for (const name of value.names) ctx.facets.delete(name);
      ctx.storage.kv.delete(key);
    }
  }
  try {
    for (const gadget of gadgets) {
      const name = journal + "_" + gadget.id;
      ctx.facets.clone(
        gadget.id === storage.defaultGadgetId.get() ? "gadget" : "gadget" + gadget.id,
        name,
      );
      copies.push({ id: gadget.id, name });
    }
    ctx.storage.kv.put(journal, { at: Date.now(), names: copies.map((c) => c.name) });
    const before = JSON.stringify(snapshot.records);
    for (const copy of copies) {
      const inspector = ctx.facets.get<WorkspaceStorageInspector>(copy.name, () =>
        snapshotOptions(ctx),
      );
      snapshot.gadgets.push({
        id: copy.id,
        state: JSON.parse(await inspector.exportState()) as WorkspaceStorage,
      });
      if (size(snapshot) > WORKSPACE_SNAPSHOT_MAX_BYTES)
        throw new Error("Workspace snapshot exceeds 2 MiB.");
    }
    if (storage.ownerId.get() !== captureOwner || storage.containsRestrictedData.get() ||
        storage.ownerInvitesOnly.get())
      throw new Error("Workspace export authority changed during capture.");
    if ([...storage.activeAgents.list()].length || [...storage.pendingAgentCalls.list()].length)
      throw new Error("Workspace started execution during snapshot. Try again.");
    const current = [...ctx.storage.kv.list()]
      .filter(([key]) => retained(key))
      .map(([key, value]) => [key, encodePortable(value)]);
    if (JSON.stringify(current) !== before)
      throw new Error("Workspace changed during snapshot. Try again.");
    const text = JSON.stringify(snapshot);
    parseWorkspaceSnapshot(text);
    return text;
  } finally {
    for (const copy of copies) ctx.facets.delete(copy.name);
    ctx.storage.kv.delete(journal);
  }
}

/** Restore into a never-opened workspace; permissions and live operation state are not imported. */
export async function restoreWorkspaceSnapshot(
  ctx: DurableObjectState,
  storage: OverseerStorage,
  ownerId: string,
  text: string,
): Promise<void> {
  const snapshot = parseWorkspaceSnapshot(text);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  ).toHex();
  const previous = ctx.storage.kv.get<string>("_vault_restored_digest");
  if (previous) {
    if (previous !== digest || storage.ownerId.get() !== ownerId)
      throw new Error("Restore operation does not match its original snapshot.");
    return;
  }
  if (storage.ownerId.get()) throw new Error("Restore target has already been opened.");
  const pending = ctx.storage.kv.get<{ digest: string; ownerId: string; names: string[] }>(
    "_vault_restore_pending",
  );
  if (pending && (pending.digest !== digest || pending.ownerId !== ownerId))
    throw new Error("Restore operation does not match its original snapshot.");
  for (const name of pending?.names ?? []) ctx.facets.delete(name);
  const records: [string, unknown][] = snapshot.records.map(([key, value]) => {
    if (!retained(key)) throw new Error("Snapshot contains permission or execution state.");
    return [key, decodePortable(value)];
  });
  const saved = new Map(records);
  if (saved.get("version") !== 4 && saved.get("version") !== OVERSEER_STORAGE_VERSION)
    throw new Error("Unsupported workspace storage version.");
  if (!/^[0-9a-f]{64}$/.test(ownerId)) throw new Error("Invalid restore owner.");
  const ids = new Set(snapshot.gadgets.map((g) => g.id));
  const gadgetIds = new Set<number>();
  const counters = { gadgets: "nextGatekeeperId", chatMeta: "nextChatId", actions: "nextActionId" };
  for (const counter of [...Object.values(counters), "nextHookId", "nextAgentCallId"]) {
    // Typed-storage defaults are not physically written until the first allocation.
    if (!saved.has(counter)) {
      saved.set(counter, 0);
      records.push([counter, 0]);
    }
    if (!Number.isSafeInteger(saved.get(counter)) || Number(saved.get(counter)) < 0)
      throw new Error("Invalid snapshot counter.");
  }
  for (const [key, value] of records) {
    if (singletons.has(key)) continue;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid business row.");
    const row = value as Record<string, unknown>,
      collection = key.split(":")[0]!;
    if (
      collection === "actions" &&
      row["type"] === "bindHook" &&
      row["hookId"] !== undefined &&
      (!Number.isSafeInteger(row["hookId"]) ||
        Number(row["hookId"]) < 0 ||
        Number(row["hookId"]) >= Number(saved.get("nextHookId")))
    )
      throw new Error("Invalid snapshot hook counter.");
    const numericKey = ["gadgets", "chatMeta", "actions"].includes(collection)
      ? row["id"]
      : ["nextChatSequences", "chatChangeBoundaries"].includes(collection)
        ? row["chatId"]
        : undefined;
    if (
      numericKey !== undefined &&
      (!Number.isSafeInteger(numericKey) ||
        Number(numericKey) < 0 ||
        key !== collection + ":" + keyString(Number(numericKey)))
    )
      throw new Error("Invalid snapshot primary key.");
    const counter = counters[collection as keyof typeof counters];
    if (
      counter &&
      (!Number.isSafeInteger(numericKey) || Number(numericKey) >= Number(saved.get(counter)))
    )
      throw new Error("Invalid snapshot counter.");
    if (collection === "gadgets") {
      const id = Number(row["id"]);
      if (
        row["type"] !== "gadget" ||
        row["pending"] ||
        !ids.has(id) ||
        gadgetIds.has(id) ||
        typeof row["bindingName"] !== "string" ||
        !(row["created"] instanceof Date) ||
        typeof row["commitId"] !== "string" ||
        !saved.has("gitObjects:" + row["commitId"])
      )
        throw new Error("Incomplete gadget snapshot.");
      gadgetIds.add(id);
    }
    if (["chats", "chatModelData", "chatChanges", "chatCompactions"].includes(collection)) {
      const numbers = [
        row["chatId"],
        collection === "chatCompactions"
          ? row["compactedTo"]
          : collection === "chatChanges"
            ? row["generation"]
            : row["sequence"],
      ];
      if (collection === "chatChanges") numbers.push(row["revision"]);
      if (
        numbers.some((n) => !Number.isSafeInteger(n) || Number(n) < 0) ||
        key !== collection + ":" + numbers.map((n) => keyString(Number(n))).join(".")
      )
        throw new Error("Invalid snapshot primary key.");
    }
    if (
      collection === "gitObjects" &&
      (!/^gitObjects:[0-9a-f]{40}$/.test(key) || !(row["data"] instanceof Uint8Array))
    )
      throw new Error("Invalid git object.");
  }
  if (gadgetIds.size !== ids.size) throw new Error("Missing gadget snapshot.");
  const defaultId = saved.get("defaultGadgetId");
  if (defaultId !== undefined && (!Number.isSafeInteger(defaultId) || Number(defaultId) < 0))
    throw new Error("Invalid default gadget.");
  const names = snapshot.gadgets.map((g) => (g.id === defaultId ? "gadget" : "gadget" + g.id));
  ctx.storage.kv.put("_vault_restore_pending", { digest, ownerId, names });
  try {
    for (const gadget of snapshot.gadgets) {
      const name = gadget.id === defaultId ? "gadget" : "gadget" + gadget.id;
      const inspector = ctx.facets.get<WorkspaceStorageInspector>(name, () => snapshotOptions(ctx));
      await inspector.importState(gadget.state);
      ctx.facets.abort(name, new Error("Restored data ready for gadget code."));
    }
    ctx.storage.transactionSync(() => {
      for (const [key, value] of records) {
        if (key.startsWith("gadgets:")) {
          if (!value || typeof value !== "object" || !("type" in value) || value.type !== "gadget")
            throw new Error("Unsupported workpiece.");
          const row = value as Record<string, unknown>,
            bindings = row["bindings"];
          if (!bindings || typeof bindings !== "object" || Array.isArray(bindings))
            throw new Error("Invalid gadget bindings.");
          const internal = Object.fromEntries(
            Object.entries(bindings).filter(
              ([, edge]) =>
                edge && typeof edge === "object" && ids.has(edge.target) && !edge.pending,
            ),
          );
          ctx.storage.kv.put(key, { ...value, bindings: internal });
        } else if (key.startsWith("chatMeta:") && value && typeof value === "object") {
          const meta = { ...value } as Record<string, unknown>;
          delete meta["activeAgent"];
          delete meta["bindingSeed"];
          ctx.storage.kv.put(key, meta);
        } else if (key.startsWith("actions:") && value && typeof value === "object") {
          if ("state" in value && value.state === "pending")
            throw new Error("Snapshot contains a pending action.");
          ctx.storage.kv.put(key, value);
        } else ctx.storage.kv.put(key, value);
      }
      storage.ownerId.put(ownerId);
      storage.title.put(snapshot.title);
      storage.gadgets.byBindingName.rebuild();
      storage.chatMeta.byLastActive.rebuild();
      storage.chats.byTimestamp.rebuild();
      storage.actions.pendingByGatekeeper.rebuild();
      storage.actions.byHistoryFilter.rebuild();
      storage.actions.byLastChanged.rebuild();
      storage.chatAttachmentContent.stagedByUploadedAt.rebuild();
      ctx.storage.kv.put("_vault_restored_digest", digest);
      ctx.storage.kv.delete("_vault_restore_pending");
    });
  } catch (error) {
    for (const name of names) ctx.facets.delete(name);
    throw error;
  }
}
