import { expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer";
import { makeOverseerStorage } from "../src/storage-schema/overseer-storage";
import type { WorkspaceStorageInspector } from "../src/workspace-storage";
import { exportWorkspaceSnapshot } from "../src/workspace-snapshot";
import { GitStore } from "../src/git-store";
import { makeActionStorage, openFakeOverseer } from "./fixtures";
import {
  decodePortable,
  parseWorkspaceSnapshot,
} from "@gadgets/workshop-shared/workspace-snapshot";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}
const owner = "a".repeat(64),
  restoredOwner = "b".repeat(64),
  origin = "https://os.example";
const emptyState = { schema: [], tables: [], kv: [] };
async function capture(name: string) {
  return runInDurableObject(env.TEST_OVERSEER.getByName(name), async (_instance, ctx) => {
    const storage = makeOverseerStorage(ctx.storage),
      git = new GitStore(storage.gitObjects);
    const commit = await git.writeFilesAsCommit(
      new Map([
        ["server.js", "export default {};"],
        ["README.md", "Saved output"],
      ]),
      {
        parents: [],
        author: { name: "Owner", email: "owner@example.test" },
        message: "Saved version",
        timestamp: new Date("2026-10-15T00:00:00.000Z"),
      },
    );
    storage.ownerId.put(owner);
    storage.version.put(4);
    storage.codeVersion.put(1);
    storage.title.put("Portable workspace");
    storage.nextHookId.put(37);
    storage.nextAgentCallId.put(12);
    storage.nextGatekeeperId.put(10);
    storage.nextChatId.put(1);
    storage.nextActionId.put(0);
    storage.defaultGadgetId.put(1);
    for (const id of [1, 2])
      storage.gadgets.put({
        type: "gadget",
        id,
        title: "App " + id,
        created: new Date("2026-10-15T00:00:00.000Z"),
        commitId: commit,
        bindingName: "APP" + id,
        bindings: id === 1 ? { INTERNAL: { target: 2 }, EXTERNAL: { target: 9 } } : {},
      });
    storage.chatMeta.put({
      id: 0,
      title: "Conversation",
      started: new Date("2026-10-15T00:00:00.000Z"),
      lastActive: new Date("2026-10-15T00:01:00.000Z"),
    });
    storage.chats.put({
      type: "message",
      chatId: 0,
      sequence: 0,
      timestamp: new Date("2026-10-15T00:01:00.000Z"),
      author: { type: "user", id: owner, name: "Owner" },
      message: "History survives",
    });
    storage.nextChatSequences.put({ chatId: 0, nextSequence: 1 });
    ctx.storage.kv.put("shareKeys:private-link", { secret: "DO NOT EXPORT" });
    ctx.storage.kv.put("gatekeepers:private-connection", { token: "DO NOT EXPORT" });
    ctx.storage.kv.put("chatContext:a0", { live: "DO NOT EXPORT" });
    storage.chatAttachmentContent.put({
      fileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      data: new Uint8Array([0, 255]),
      state: { type: "committed", chatId: 0 },
    });
    const facet = ctx.facets.get<WorkspaceStorageInspector>("gadget", () => ({
      class: ctx.exports.WorkspaceStorageInspector,
    }));
    await facet.importState({
      schema: [
        {
          type: "table",
          name: "notes",
          sql: "CREATE TABLE notes(id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT)",
        },
      ],
      tables: [
        { name: "notes", columns: ["id", "body"], rows: [[7, "Stored app note"]], sequence: 42 },
      ],
      kv: [["settings", "Retained preference"]],
    });
    await ctx.facets
      .get<WorkspaceStorageInspector>("gadget2", () => ({
        class: ctx.exports.WorkspaceStorageInspector,
      }))
      .importState(emptyState);
    const text = await exportWorkspaceSnapshot(ctx, storage, origin);
    expect([...ctx.storage.kv.list({ prefix: "_vault_snapshot_" })]).toEqual([]);
    expect(JSON.parse(await facet.exportState()).kv).toEqual([["settings", "Retained preference"]]);
    expect(ctx.storage.kv.get("shareKeys:private-link")).toEqual({ secret: "DO NOT EXPORT" });
    return text;
  });
}
it("restores chat history, git files, attachments, multiple gadget SQL/KV and counters into a fresh owner workspace", async () => {
  const text = await capture("whole-snapshot-source");
  expect(text).not.toContain("DO NOT EXPORT");
  const snapshot = parseWorkspaceSnapshot(text);
  expect(snapshot.gadgets).toHaveLength(2);
  const target = env.TEST_OVERSEER.getByName("whole-snapshot-target");
  await target.restoreWorkspaceSnapshotForOwner(restoredOwner, text);
  await target.restoreWorkspaceSnapshotForOwner(restoredOwner, text);
  await runInDurableObject(target, async (_instance, ctx) => {
    const storage = makeOverseerStorage(ctx.storage);
    expect(storage.ownerId.get()).toBe(restoredOwner);
    expect(storage.nextHookId.get()).toBe(37);
    expect(storage.nextAgentCallId.get()).toBe(12);
    expect(storage.version.get()).toBe(5);
    expect(storage.chats.get("a0.a0")?.type).toBe("message");
    expect(storage.chats.byTimestamp.list().next().value?.message).toBe("History survives");
    expect(storage.gadgets.byBindingName.get("APP1")?.bindings).toEqual({
      INTERNAL: { target: 2 },
    });
    const gadget = storage.gadgets.get(1);
    expect(gadget?.type).toBe("gadget");
    expect(await new GitStore(storage.gitObjects).readCommitFiles(gadget!.commitId!)).toEqual(
      new Map([
        ["README.md", "Saved output"],
        ["server.js", "export default {};"],
      ]),
    );
    expect(storage.chatAttachmentContent.get("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")?.data).toEqual(
      new Uint8Array([0, 255]),
    );
    expect([...storage.shareKeys.list()]).toEqual([]);
    expect([...storage.gatekeepers.list()]).toEqual([]);
    expect([...storage.chatContext.list()]).toEqual([]);
    const state = JSON.parse(
      await ctx.facets
        .get<WorkspaceStorageInspector>("gadget", () => ({
          class: ctx.exports.WorkspaceStorageInspector,
        }))
        .exportState(),
    );
    expect(state.tables[0].rows).toEqual([[7, 7, "Stored app note"]]);
    expect(state.tables[0].sequence).toBe(42);
    expect(state.kv).toEqual([["settings", "Retained preference"]]);
    ctx.facets.delete("gadget");
    ctx.facets.delete("gadget2");
  });
  try {
    await target.restoreWorkspaceSnapshotForOwner(
      restoredOwner,
      text.replace("Portable workspace", "Changed workspace"),
    );
    throw new Error("expected refusal");
  } catch (e) {
    expect(String(e)).toContain("does not match");
  }
  try {
    await target.restoreWorkspaceSnapshotForOwner(owner, text);
    throw new Error("expected refusal");
  } catch (e) {
    expect(String(e)).toContain("does not match");
  }
  expect(
    snapshot.records.some(
      ([key]) =>
        key.startsWith("gitObjects:") &&
        decodePortable(snapshot.records.find(([k]) => k === key)![1]),
    ),
  ).toBe(true);
});
it("restores a workspace whose unused allocation counters exist only as typed-storage defaults", async () => {
  const text = await runInDurableObject(
    env.TEST_OVERSEER.getByName("unused-counters-source"),
    async (_instance, ctx) => {
      const storage = makeOverseerStorage(ctx.storage);
      storage.ownerId.put(owner);
      storage.version.put(5);
      storage.codeVersion.put(1);
      return exportWorkspaceSnapshot(ctx, storage, origin);
    },
  );
  const target = env.TEST_OVERSEER.getByName("unused-counters-target");
  await target.restoreWorkspaceSnapshotForOwner(restoredOwner, text);
  await runInDurableObject(target, (_instance, ctx) => {
    const storage = makeOverseerStorage(ctx.storage);
    expect(storage.nextGatekeeperId.get()).toBe(0);
    expect(storage.nextChatId.get()).toBe(0);
    expect(storage.nextActionId.get()).toBe(0);
    expect(storage.nextHookId.get()).toBe(0);
    expect(storage.nextAgentCallId.get()).toBe(0);
    expect(storage.ownerId.get()).toBe(restoredOwner);
  });
});
it.each(["containsRestrictedData", "ownerInvitesOnly"] as const)(
    "refuses disclosure if %s changes during an awaited facet read and removes private copies", async flag => {
  const source = "capture-authority-source-" + flag;
  await capture(source);
  await runInDurableObject(
    env.TEST_OVERSEER.getByName(source),
    async (_instance, ctx) => {
      const storage = makeOverseerStorage(ctx.storage);
      const result = exportWorkspaceSnapshot(ctx, storage, origin);
      storage[flag].put(true);
      await expect(result).rejects.toThrow("authority changed");
      expect([...ctx.storage.kv.list({ prefix: "_vault_snapshot_" })]).toEqual([]);
    },
  );
});
it("rejects missing child data and live authority rows before claiming ownership", async () => {
  const snapshot = parseWorkspaceSnapshot(await capture("invalid-snapshot-source"));
  for (const [name, changed, message] of [
    ["missing-child", { ...snapshot, gadgets: snapshot.gadgets.slice(0, 1) }, "Incomplete gadget"],
    [
      "authority-row",
      { ...snapshot, records: [...snapshot.records, ["ownerId", owner]] },
      "permission or execution",
    ],
  ] as const) {
    const target = env.TEST_OVERSEER.getByName(name);
    try {
      await target.restoreWorkspaceSnapshotForOwner(restoredOwner, JSON.stringify(changed));
      throw new Error("expected refusal");
    } catch (e) {
      expect(String(e)).toContain(message);
    }
    await runInDurableObject(target, (_instance, ctx) =>
      expect(makeOverseerStorage(ctx.storage).ownerId.get()).toBeUndefined(),
    );
  }
});
it("denies both build and use collaborators before touching export storage", async () => {
  for (const role of ["build", "use"] as const) {
    const viewer = await openFakeOverseer(makeActionStorage(), {
      role,
      impl: { ownerId: "another-owner" },
    });
    try {
      await expect(viewer.exportWorkspaceSnapshot(origin)).rejects.toThrow(
        role === "build" ? "Only the workspace owner" : "Unauthorized",
      );
    } finally {
      const dispose = Reflect.get(viewer, Symbol.dispose);
      if (typeof dispose === "function") dispose.call(viewer);
    }
  }
});
it("reaps interrupted private facet staging and safely retries the same owner-bound restore", async () => {
  const text = await capture("retry-snapshot-source");
  const target = env.TEST_OVERSEER.getByName("retry-snapshot-target");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  ).toHex();
  await runInDurableObject(target, async (_instance, ctx) => {
    ctx.storage.kv.put("_vault_restore_pending", {
      digest,
      ownerId: restoredOwner,
      names: ["gadget"],
    });
    await ctx.facets
      .get<WorkspaceStorageInspector>("gadget", () => ({
        class: ctx.exports.WorkspaceStorageInspector,
      }))
      .importState({ schema: [], tables: [], kv: [["partial", "Uncommitted state"]] });
  });
  await target.restoreWorkspaceSnapshotForOwner(restoredOwner, text);
  await runInDurableObject(target, async (_instance, ctx) => {
    expect(ctx.storage.kv.get("_vault_restore_pending")).toBeUndefined();
    expect(makeOverseerStorage(ctx.storage).ownerId.get()).toBe(restoredOwner);
    const data = JSON.parse(
      await ctx.facets
        .get<WorkspaceStorageInspector>("gadget", () => ({
          class: ctx.exports.WorkspaceStorageInspector,
        }))
        .exportState(),
    );
    expect(data.kv).toEqual([["settings", "Retained preference"]]);
    ctx.facets.delete("gadget");
    ctx.facets.delete("gadget2");
  });
});
