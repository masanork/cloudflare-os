import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@cloudflare/kumo";
import type { Overseer } from "@gadgets/workshop-shared/api";
import { useAuthenticatedApi } from "../../AuthContext";
import { vaultDestination } from "./vaultArchive";
import { transferWorkspace, type WorkspaceTransfer } from "./vaultWorkspace";

export const WorkspaceVault = ({
  reader,
}: {
  reader: Pick<Overseer, "exportWorkspaceSnapshot">;
}) => {
  const destination = vaultDestination(import.meta.env.VITE_MIKAKI_VAULT_URL);
  const { authenticatedApi } = useAuthenticatedApi();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false),
    [status, setStatus] = useState(""),
    [retry, setRetry] = useState(false);
  const control = useRef<AbortController | null>(null);
  // Kept only for this mounted view. An uncertain response retries the exact same operation.
  const pending = useRef<{
    transfer: WorkspaceTransfer;
    snapshot: string;
    operationId: string;
  } | null>(null);
  useEffect(
    () => () => {
      control.current?.abort();
      pending.current = null;
    },
    [],
  );
  if (!destination) return null;
  const restorePending = async (signal: AbortSignal) => {
    const attempt = pending.current;
    if (!attempt) throw new Error("Choose a snapshot first.");
    const id = await authenticatedApi.newGadgetFromWorkspaceSnapshot(
      attempt.snapshot,
      attempt.operationId,
    );
    if (signal.aborted) return;
    attempt.transfer.restored();
    pending.current = null;
    setRetry(false);
    setStatus("A new workspace was restored. Reconnect external services there.");
    void navigate({ to: "/workspace/$id", params: { id }, search: {} });
  };
  const run = async (mode: "save" | "restore") => {
    if (busy) return;
    const abort = new AbortController();
    control.current = abort;
    setBusy(true);
    setStatus(
      mode === "save"
        ? "Unlock Mikaki and review the workspace copy before saving."
        : "Unlock Mikaki, choose a saved snapshot and approve sending its contents here.",
    );
    try {
      if (pending.current) await restorePending(abort.signal);
      else {
        const transfer = await transferWorkspace(
          destination,
          mode,
          () => reader.exportWorkspaceSnapshot(location.origin),
          abort.signal,
        );
        if (abort.signal.aborted) return;
        if (mode === "save")
          setStatus("Mikaki confirmed the encrypted workspace snapshot was saved.");
        else {
          if (!transfer.snapshot) throw new Error("No snapshot received.");
          pending.current = {
            transfer,
            snapshot: transfer.snapshot,
            operationId: crypto.randomUUID(),
          };
          await restorePending(abort.signal);
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        setRetry(pending.current !== null);
        setStatus(
          error instanceof Error ? error.message : "Could not confirm the workspace transfer.",
        );
      }
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  };
  return (
    <details className="shrink-0 border-b border-kumo-line">
      <summary className="px-4 py-2 text-sm text-kumo-subtle cursor-pointer">
        Workspace in Vault
      </summary>
      <div className="flex flex-col gap-1 px-4 py-2">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || retry}
            onClick={() => void run("save")}
          >
            Save workspace to Vault
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void run("restore")}>
            {retry ? "Retry the same restore" : "Restore workspace from Vault"}
          </Button>
          {retry && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => {
                pending.current = null;
                setRetry(false);
                setStatus(
                  "Pending restore discarded. If the earlier request completed, its workspace remains in your workspace list. You can now choose another snapshot.",
                );
              }}
            >
              Discard pending restore
            </Button>
          )}
        </div>
        {retry && (
          <p className="text-xs text-kumo-subtle">
            Retry safely repeats the same restore. Before discarding it, check your workspace list
            in case the earlier request completed.
          </p>
        )}
        <p className="text-xs text-kumo-subtle">
          Up to 2 MiB of conversations, attachments, code history and gadget SQL/KV data. Finish
          agents and commit changes first. External connections and sharing must be configured
          again.
        </p>
        {status && (
          <p className="text-xs text-kumo-subtle" role="status">
            {status}
          </p>
        )}
      </div>
    </details>
  );
};
