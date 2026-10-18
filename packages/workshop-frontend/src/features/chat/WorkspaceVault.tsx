import { useState, useSyncExternalStore } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@cloudflare/kumo";
import { useAuthenticatedApi } from "../../AuthContext";
import { vaultDestination } from "./vaultArchive";
import type { WorkspaceVaultSession } from "./workspaceVaultSession";

const WorkspaceVaultControls = ({ workspaceId, workspaceVault }: {
  workspaceId: string; workspaceVault: WorkspaceVaultSession;
}) => {
  const destination = vaultDestination(import.meta.env.VITE_MIKAKI_VAULT_URL);
  const state = useSyncExternalStore(workspaceVault.subscribe, workspaceVault.snapshot);
  const [open, setOpen] = useState(state.busy || state.retry);
  const navigate = useNavigate();
  if (!destination) return null;
  const run = (mode: "save" | "restore") => workspaceVault.start(
    workspaceId, destination, mode,
    id => { void navigate({ to: "/workspace/$id", params: { id }, search: {} }); },
  );
  return (
    <details className="shrink-0 border-b border-kumo-line" open={open}
      onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="px-4 py-2 text-sm text-kumo-subtle cursor-pointer">
        Workspace in Vault
      </summary>
      <div className="flex flex-col gap-1 px-4 py-2">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={state.busy || state.retry}
            onClick={() => void run("save")}
          >
            Save workspace to Vault
          </Button>
          <Button variant="secondary" size="sm" disabled={state.busy} onClick={() => void run("restore")}>
            {state.retry ? "Retry the same restore" : "Restore workspace from Vault"}
          </Button>
          {state.retry && (
            <Button
              variant="secondary"
              size="sm"
              disabled={state.busy}
              onClick={() => workspaceVault.discard()}
            >
              Discard pending restore
            </Button>
          )}
        </div>
        {state.retry && (
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
        {state.status && (
          <p className="text-xs text-kumo-subtle" role="status">
            {state.status}
          </p>
        )}
      </div>
    </details>
  );
};

export const WorkspaceVault = ({ workspaceId }: { workspaceId: string }) => {
  const { workspaceVault } = useAuthenticatedApi();
  return workspaceVault ? <WorkspaceVaultControls workspaceId={workspaceId} workspaceVault={workspaceVault} /> : null;
};
