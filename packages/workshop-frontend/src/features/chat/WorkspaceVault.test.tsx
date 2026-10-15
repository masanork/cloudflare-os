// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceVault } from "./WorkspaceVault";

const mocks = vi.hoisted(() => ({
  restore: vi.fn<(snapshot: string, operationId: string) => Promise<string>>(),
  transfer: vi.fn<typeof import("./vaultWorkspace").transferWorkspace>(),
  navigate: vi.fn<(options: unknown) => void>(),
}));
vi.mock("../../AuthContext", () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: { newGadgetFromWorkspaceSnapshot: mocks.restore },
  }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("./vaultWorkspace", () => ({ transferWorkspace: mocks.transfer }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
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
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<WorkspaceVault reader={{ exportWorkspaceSnapshot: async () => "" }} />));
});
afterEach(() => {
  act(() => root.unmount());
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
