import { afterEach, expect, it, vi } from "vitest";
import { transferWorkspace } from "./vaultWorkspace";
afterEach(() => vi.useRealTimers());
const origin = "https://os.example";
const snapshot = JSON.stringify({
  format: "cloudflare-os-workspace",
  version: 1,
  title: "Workspace",
  source: { origin, workspaceId: "a".repeat(64), capturedAt: "2026-10-15T00:00:00.000Z" },
  records: [["version", 4]],
  gadgets: [],
});
function fixture() {
  vi.useFakeTimers();
  let listener: ((event: MessageEvent) => void) | undefined;
  const sent: Record<string, unknown>[] = [];
  const popup = {
    closed: false,
    postMessage: (v: Record<string, unknown>, target: string) => {
      expect(target).toBe("https://mikaki.example");
      sent.push(v);
    },
  };
  const host = {
    location: { origin },
    open: () => popup,
    addEventListener: (_: string, fn: typeof listener) => {
      listener = fn;
    },
    removeEventListener: vi.fn<() => void>(),
  };
  const receive = (
    type: string,
    extra = {},
    from = "https://mikaki.example",
    source: unknown = popup,
  ) => listener!({ source, origin: from, data: { ...sent[0], type, ...extra } } as MessageEvent);
  return { host: host as unknown as Window, sent, receive, popup };
}
it("save reads once from the owner RPC after unlock and waits for a matching post-commit receipt", async () => {
  const f = fixture(),
    read = vi.fn<() => Promise<string>>(async () => snapshot);
  const result = transferWorkspace(
    new URL("https://mikaki.example/vault"),
    "save",
    read,
    new AbortController().signal,
    f.host,
  );
  await vi.advanceTimersByTimeAsync(750);
  f.receive("saved");
  f.receive("request", {}, "https://wrong.example");
  f.receive("request", {}, "https://mikaki.example", {});
  expect(read).not.toHaveBeenCalled();
  f.receive("request");
  f.receive("request");
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(1);
  expect(f.sent[1]).toMatchObject({ type: "snapshot", snapshot });
  f.receive("saved");
  expect((await result).snapshot).toBeUndefined();
  expect(f.sent).toHaveLength(2);
});
it("restore receives only from the pinned popup and reports completion after the caller restores", async () => {
  const f = fixture(),
    read = vi.fn<() => Promise<string>>();
  const result = transferWorkspace(
    new URL("https://mikaki.example/vault"),
    "restore",
    read,
    new AbortController().signal,
    f.host,
  );
  await vi.advanceTimersByTimeAsync(750);
  f.receive("snapshot", { snapshot }, "https://wrong.example");
  f.receive("snapshot", { snapshot }, "https://mikaki.example", {});
  expect(f.sent).toHaveLength(1);
  f.receive("snapshot", { snapshot });
  const received = await result;
  expect(received.snapshot).toBe(snapshot);
  expect(read).not.toHaveBeenCalled();
  expect(f.sent).toHaveLength(1);
  received.restored();
  expect(f.sent[1]).toMatchObject({ type: "restored" });
});
it("source mismatch and cancellation cannot disclose or restore a workspace", async () => {
  const f = fixture(),
    control = new AbortController();
  const result = transferWorkspace(
    new URL("https://mikaki.example/vault"),
    "restore",
    async () => "",
    control.signal,
    f.host,
  );
  const refused = result.catch((error) => error);
  await vi.advanceTimersByTimeAsync(750);
  f.receive("snapshot", { snapshot: snapshot.replace(origin, "https://other.example") });
  expect((await refused).message).toContain("different app origin");
  const other = fixture(),
    aborted = transferWorkspace(
      new URL("https://mikaki.example/vault"),
      "save",
      async () => snapshot,
      control.signal,
      other.host,
    );
  const cancelled = aborted.catch((error) => error);
  control.abort();
  expect((await cancelled).message).toContain("cancelled");
});
