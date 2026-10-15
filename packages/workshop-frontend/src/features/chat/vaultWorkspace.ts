import { parseWorkspaceSnapshot } from "@gadgets/workshop-shared/workspace-snapshot";
import { vaultDestination } from "./vaultArchive";

const PROTOCOL = "mikaki-workspace-v1";
export type WorkspaceTransfer = { snapshot?: string; restored: () => void };

/** Transfer a selected workspace copy between two explicitly pinned browser windows. */
export const transferWorkspace = (
  destination: URL,
  mode: "save" | "restore",
  readSnapshot: () => Promise<string>,
  signal: AbortSignal,
  host: Window = window,
): Promise<WorkspaceTransfer> => {
  if (!vaultDestination(destination.href)) return Promise.reject(new Error("Invalid Vault URL."));
  const popup = host.open(destination.href, "_blank", "popup,width=720,height=840");
  if (!popup) return Promise.reject(new Error("Allow pop-ups to open Mikaki."));
  const channel = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let active = true,
      requested = false,
      delivered = false;
    const post = (type: string, extra: Record<string, unknown> = {}) =>
      popup.postMessage({ protocol: PROTOCOL, channel, type, ...extra }, destination.origin);
    const finish = (error?: Error, snapshot?: string) => {
      if (!active) return;
      active = false;
      clearInterval(poll);
      clearTimeout(timeout);
      host.removeEventListener("message", receive);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else
        resolve({
          snapshot,
          restored: () => {
            if (!signal.aborted && !popup.closed) post("restored");
          },
        });
    };
    const abort = () => finish(new Error("Workspace transfer was cancelled."));
    const receive = (event: MessageEvent) => {
      if (
        !active ||
        signal.aborted ||
        event.source !== popup ||
        event.origin !== destination.origin
      )
        return;
      const v = event.data;
      if (!v || typeof v !== "object" || v.protocol !== PROTOCOL || v.channel !== channel) return;
      if (mode === "save" && v.type === "saved" && delivered) finish();
      if (mode === "restore" && v.type === "snapshot") {
        try {
          if (
            typeof v.snapshot !== "string" ||
            parseWorkspaceSnapshot(v.snapshot).source.origin !== host.location.origin
          )
            throw new Error("This snapshot belongs to a different app origin.");
          finish(undefined, v.snapshot);
        } catch (error) {
          finish(error instanceof Error ? error : new Error("Invalid workspace snapshot."));
        }
      }
      if (mode !== "save" || v.type !== "request" || requested) return;
      requested = true;
      void readSnapshot()
        .then((snapshot) => {
          if (!active || signal.aborted) return;
          if (parseWorkspaceSnapshot(snapshot).source.origin !== host.location.origin)
            throw new Error("Workspace source mismatch.");
          delivered = true;
          post("snapshot", { snapshot });
        })
        .catch((error) =>
          finish(error instanceof Error ? error : new Error("Could not read the workspace.")),
        );
    };
    const poll = setInterval(() => {
      if (popup.closed) finish(new Error("Mikaki closed before the transfer was confirmed."));
      else if (!requested) post("offer", { mode });
    }, 750);
    const timeout = setTimeout(
      () =>
        finish(
          new Error("Workspace transfer timed out. Check Mikaki or Cloudflare OS for the result."),
        ),
      300_000,
    );
    host.addEventListener("message", receive);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
};
