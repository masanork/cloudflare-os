// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RpcPromise } from "capnweb";
import { WorkspaceVault } from "./WorkspaceVault";
import { WorkspaceVaultSession, type VaultApi } from "./workspaceVaultSession";
import { AuthenticatedSession } from "../auth/authenticatedSession";

const mocks = vi.hoisted(() => ({
  vault: null as WorkspaceVaultSession | null,
  restore: vi.fn<(snapshot: string, operationId: string) => Promise<string>>(),
  transfer: vi.fn<typeof import("./vaultWorkspace").transferWorkspace>(),
  navigate: vi.fn<(options: unknown) => void>(),
}));
vi.mock("../../AuthContext", () => ({
  useAuthenticatedApi: () => ({
    workspaceVault: mocks.vault,
  }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("./vaultWorkspace", () => ({ transferWorkspace: mocks.transfer }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let session: AuthenticatedSession<VaultApi>;
let untrack: () => void;
const person = { type: "user" as const, id: "alice", name: "Alice" };
const makeApi = (restore = mocks.restore): VaultApi => ({
  newGadgetFromWorkspaceSnapshot: (snapshot, operationId) => {
    if (typeof snapshot !== "string" || typeof operationId !== "string") throw new Error("Expected resolved snapshot and operation ID");
    return new RpcPromise(restore(snapshot, operationId));
  },
  openGadget: vi.fn<VaultApi["openGadget"]>(),
  onRpcBroken: vi.fn<VaultApi["onRpcBroken"]>(),
});
const render = () => root.render(<WorkspaceVault workspaceId="source-id" />);
let container: HTMLDivElement;
const button = (text: string) =>
  Array.from(container.querySelectorAll("button")).find((item) => item.textContent === text)!;
const click = async (text: string) => {
  await act(async () => button(text).click());
};

beforeEach(() => {
  vi.stubEnv("VITE_MIKAKI_VAULT_URL", "https://mikaki.example/vault");
  mocks.restore.mockReset();
  mocks.transfer.mockReset();
  mocks.navigate.mockReset();
  session = new AuthenticatedSession<VaultApi>();
  untrack = session.track(makeApi(), Promise.resolve(person));
  mocks.vault = new WorkspaceVaultSession(session);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(render);
});
afterEach(() => {
  act(() => { session.end(); root.unmount(); });
  container.remove();
  vi.unstubAllEnvs();
});

it("retries the identical operation after an uncertain failure and confirms only success", async () => {
  const restored = vi.fn<() => void>();
  mocks.transfer.mockResolvedValue({ snapshot: "first snapshot", restored });
  mocks.restore.mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValueOnce("new-id");
  await click("Restore workspace from Vault");
  expect(container.textContent).toContain("Connection lost");
  expect(button("Save workspace to Vault").disabled).toBe(true);
  expect(restored).not.toHaveBeenCalled();
  const first = mocks.restore.mock.calls[0];
  await click("Retry the same restore");
  expect(mocks.restore.mock.calls[1]).toEqual(first);
  expect(mocks.transfer).toHaveBeenCalledTimes(1);
  expect(restored).toHaveBeenCalledOnce();
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/workspace/$id",
    params: { id: "new-id" },
    search: {},
  });
});

it("lets the owner discard a rejected snapshot and select another without reloading", async () => {
  const rejectedReceipt = vi.fn<() => void>(),
    restored = vi.fn<() => void>();
  mocks.transfer
    .mockResolvedValueOnce({ snapshot: "unsupported snapshot", restored: rejectedReceipt })
    .mockResolvedValueOnce({ snapshot: "valid snapshot", restored });
  mocks.restore
    .mockRejectedValueOnce(new Error("Unsupported storage version"))
    .mockResolvedValueOnce("new-id");
  await click("Restore workspace from Vault");
  const previousOperation = mocks.restore.mock.calls[0][1];
  expect(container.textContent).toContain("check your workspace list");
  await click("Discard pending restore");
  expect(button("Save workspace to Vault").disabled).toBe(false);
  expect(container.textContent).toContain("You can now choose another snapshot");
  await click("Restore workspace from Vault");
  expect(mocks.transfer).toHaveBeenCalledTimes(2);
  expect(mocks.restore.mock.calls[1][0]).toBe("valid snapshot");
  expect(mocks.restore.mock.calls[1][1]).not.toBe(previousOperation);
  expect(rejectedReceipt).not.toHaveBeenCalled();
  expect(restored).toHaveBeenCalledOnce();
});

it("keeps the popup transfer while authentication unmounts the workspace view", async () => {
  let deliver!: (transfer: Awaited<ReturnType<typeof mocks.transfer>>) => void;
  mocks.transfer.mockImplementation(() => new Promise(resolve => { deliver = resolve; }));
  const restored = vi.fn<() => void>();
  const replacementRestore = vi.fn<typeof mocks.restore>().mockResolvedValue("new-id");
  await click("Restore workspace from Vault");
  const signal = mocks.transfer.mock.calls[0][3];
  act(() => root.unmount());
  untrack();
  expect(signal.aborted).toBe(false);
  await act(async () => {
    deliver({ snapshot: "selected snapshot", restored });
    await Promise.resolve();
  });
  expect(mocks.restore).not.toHaveBeenCalled();
  await act(async () => {
    session.track(makeApi(replacementRestore), Promise.resolve(person));
    root = createRoot(container);
    render();
  });
  expect(mocks.transfer).toHaveBeenCalledOnce();
  expect(replacementRestore).toHaveBeenCalledOnce();
  expect(replacementRestore.mock.calls[0][0]).toBe("selected snapshot");
  expect(restored).toHaveBeenCalledOnce();
  expect(mocks.navigate).toHaveBeenCalledOnce();
});

it("retries an interrupted restore on the replacement API with the identical operation ID", async () => {
  let fail!: (error: Error) => void;
  mocks.restore.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
  const restored = vi.fn<() => void>();
  mocks.transfer.mockResolvedValue({ snapshot: "selected snapshot", restored });
  await click("Restore workspace from Vault");
  const first = mocks.restore.mock.calls[0];
  const replacementRestore = vi.fn<typeof mocks.restore>().mockResolvedValue("new-id");
  await act(async () => {
    untrack();
    fail(new Error("socket lost after commit"));
    session.track(makeApi(replacementRestore), Promise.resolve(person));
  });
  expect(replacementRestore).toHaveBeenCalledExactlyOnceWith(...first);
  expect(mocks.transfer).toHaveBeenCalledOnce();
  expect(restored).toHaveBeenCalledOnce();
});

it.each(["sign out", "another workspace"])("clears a pending popup on %s", async reason => {
  let deliver!: (transfer: Awaited<ReturnType<typeof mocks.transfer>>) => void;
  mocks.transfer.mockImplementation(() => new Promise(resolve => { deliver = resolve; }));
  const restored = vi.fn<() => void>();
  await click("Restore workspace from Vault");
  const signal = mocks.transfer.mock.calls[0][3];
  await act(async () => {
    if (reason === "sign out") session.end();
    else mocks.vault!.setPath("/workspace/another-id");
    deliver({ snapshot: "selected snapshot", restored });
  });
  expect(signal.aborted).toBe(true);
  expect(mocks.restore).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(restored).not.toHaveBeenCalled();
  expect(mocks.vault!.snapshot()).toEqual({ workspaceId: "", busy: false, status: "", retry: false });
});

it("clears an uncertain restore when the replacement API belongs to another user", async () => {
  mocks.transfer.mockResolvedValue({ snapshot: "selected snapshot", restored: vi.fn<() => void>() });
  mocks.restore.mockRejectedValue(new Error("uncertain result"));
  await click("Restore workspace from Vault");
  expect(mocks.vault!.snapshot().retry).toBe(true);
  const replacementRestore = vi.fn<typeof mocks.restore>().mockResolvedValue("wrong-user-id");
  await act(async () => session.track(makeApi(replacementRestore),
    Promise.resolve({ ...person, id: "bob" })));
  expect(mocks.vault!.snapshot().retry).toBe(false);
  expect(replacementRestore).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
});
