import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { RpcStub } from "capnweb";
import { bundleBlueprints, startHarness } from "./harness.js";
import { connect, logIn, nextUsernames, signUp, waitFor } from "./rpc-client.js";

const title = "Saved app and conversation";
const message = "Workspace private payload ".repeat(3000);
const attachment = new Uint8Array([0, 255, 1, 2]);
const blueprintId = "vault.fixture";
type NotesApp = {
  putNote(body: string): Promise<void>;
  readNotes(): Promise<{ id: number; body: string }[]>;
  setTheme(theme: string): Promise<void>;
  getTheme(): Promise<string>;
};
const server = `import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT)");
  }
  putNote(body) { this.ctx.storage.sql.exec("INSERT INTO notes(body) VALUES (?)", body); }
  readNotes() { return this.ctx.storage.sql.exec("SELECT id, body FROM notes ORDER BY id").toArray(); }
  setTheme(theme) { this.ctx.storage.kv.put("theme", theme); }
  getTheme() { return this.ctx.storage.kv.get("theme"); }
}`;

/** Real authenticated WebSocket fixture shared with Mikaki's optional paired browser test. */
export async function startWorkspaceVaultFixture(origin: string) {
  const harness = await startHarness({
    gatekeepers: [],
    enableGadgetExecution: true,
    patchWorkshop: bundleBlueprints([{
      blueprintId, title: "Vault notes", version: 1,
      files: { "server.js": server, "client.js": 'document.body.textContent = "Vault notes";' },
    }]),
  });
  const publicApi = connect(harness.url);
  const held: Disposable[] = [publicApi];
  const close = async () => {
    for (const stub of held.toReversed()) stub[Symbol.dispose]();
    await harness.server.close();
  };
  try {
    const [username, otherUsername] = nextUsernames("vaultowner", "vaultother");
    const token = await publicApi.createAccount(username, username,
        new Uint8Array(createHash("sha256").update(`integration-test:${username}`).digest()));
    assert.ok(token);
    const api = await publicApi.authenticate(token);
    held.push(api);
    await api.completeOnboarding();
    const otherApi = await signUp(publicApi, otherUsername);
    held.push(otherApi);
    const ws = await api.newGadgetFromBlueprint(blueprintId, {});
    held.push(ws);
    await ws.setTitle(title);
    const metadata = await ws.getMetadata();
    const gadgetId = metadata.defaultGadgetId;
    assert.notEqual(gadgetId, undefined);
    using gadget = await ws.getGadget(gadgetId!);
    using app = await gadget.connectToGadget() as RpcStub<NotesApp>;
    await app.putNote("Saved gadget note");
    await app.setTheme("dark");
    const ref = await ws.uploadChatAttachment({
      mimeType: "text/plain", name: "state.txt", content: attachment,
    }, null);
    const chatId = await ws.newChat(message, null, undefined, [ref]);
    await ws.sendChatMessage(chatId, "Second message", null);
    const snapshot = await ws.exportWorkspaceSnapshot(origin);
    // Finish the initial sweep so a later list cannot repair a missing restore-side index update.
    await api.listOutputs();

    const verifyRestored = async (id: string) => {
      assert.notEqual(id, metadata.id);
      const listed = await waitFor("restored workspace registration", async () => {
        const entries = await api.listGadgets();
        return entries.some(entry => entry.id === id) ? entries : null;
      });
      assert.equal(listed.find(entry => entry.id === id)?.title, title);
      assert.ok((await api.listOutputs()).outputs.some(entry =>
          entry.workspaceId === id && entry.workpieceId === gadgetId));
      // A new session must reopen the result through the public broker, without the original stub.
      using reopenedPublic = connect(harness.url);
      using reopenedApi = await logIn(reopenedPublic, username);
      using reopened = await reopenedApi.openGadget(id);
      assert.equal((await reopened.getMetadata()).title, title);
      const history = await reopened.getChatHistory(chatId);
      assert.deepEqual(history.messages.filter(entry => entry.type === "message")
          .map(entry => entry.message), [message, "Second message"]);
      assert.deepEqual(Array.from(await reopened.getChatAttachmentContent(chatId, ref.id)),
          Array.from(attachment));
      using restoredGadget = await reopened.getGadget(gadgetId!);
      using restoredApp = await restoredGadget.connectToGadget() as RpcStub<NotesApp>;
      assert.deepEqual(await restoredApp.readNotes(), [{ id: 1, body: "Saved gadget note" }]);
      assert.equal(await restoredApp.getTheme(), "dark");
      await restoredApp.putNote("Added after restore");
      assert.deepEqual(await restoredApp.readNotes(), [
        { id: 1, body: "Saved gadget note" }, { id: 2, body: "Added after restore" },
      ]);
      using originalGadget = await ws.getGadget(gadgetId!);
      using originalApp = await originalGadget.connectToGadget() as RpcStub<NotesApp>;
      assert.deepEqual(await originalApp.readNotes(), [{ id: 1, body: "Saved gadget note" }]);
      assert.equal((await ws.getMetadata()).id, metadata.id);
      assert.deepEqual((await ws.getChatHistory(chatId)).messages.filter(entry => entry.type === "message")
          .map(entry => entry.message), [message, "Second message"]);
      await assert.rejects(async () => {
        using _opened = await otherApi.openGadget(id);
      });
      return id;
    };
    const restore = async (text: string, operationId = randomUUID()) => {
      const id = await api.newGadgetFromWorkspaceSnapshot(text, operationId);
      assert.equal(await api.newGadgetFromWorkspaceSnapshot(text, operationId), id);
      return verifyRestored(id);
    };
    // Keep only the source workspace stubs alive after this scope's gadget/app stubs are disposed.
    return {
      title, snapshot, restore, close, verifyRestored,
      browserSession: { url: harness.url.toString(), token, workspaceId: metadata.id, chatId },
      exportSnapshot: () => ws.exportWorkspaceSnapshot(origin),
      restoreRaw: (text: string, operationId: string) =>
        api.newGadgetFromWorkspaceSnapshot(text, operationId),
      restoreAsOther: (text: string, operationId: string) =>
        otherApi.newGadgetFromWorkspaceSnapshot(text, operationId),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
