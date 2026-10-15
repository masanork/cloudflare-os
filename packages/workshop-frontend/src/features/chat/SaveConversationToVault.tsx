import { useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo";
import {
  makeVaultArchive,
  sendVaultArchive,
  vaultDestination,
  type VaultArchiveReader,
} from "./vaultArchive";

export const SaveConversationToVault = ({
  reader,
  workspaceId,
  chatId,
  title,
}: {
  reader: VaultArchiveReader;
  workspaceId: string;
  chatId: number;
  title: string;
}) => {
  const destination = vaultDestination(import.meta.env.VITE_MIKAKI_VAULT_URL);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const transfer = useRef<AbortController | null>(null);
  useEffect(() => () => transfer.current?.abort(), []);
  if (!destination) return null;
  const save = async () => {
    if (busy) return;
    const control = new AbortController();
    transfer.current = control;
    setBusy(true);
    setStatus("Sign in and unlock your Vault in Mikaki, then review and save the text segment.");
    try {
      await sendVaultArchive(
        destination,
        async () =>
          makeVaultArchive(await reader.getChatHistory(chatId), {
            origin: location.origin,
            workspaceId,
            chatId,
            title,
          }),
        control.signal,
      );
      if (!control.signal.aborted) setStatus("Mikaki confirmed that the encrypted copy was saved.");
    } catch (error) {
      if (!control.signal.aborted)
        setStatus(error instanceof Error ? error.message : "Saving could not be confirmed.");
    } finally {
      if (!control.signal.aborted) setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-1 px-4 py-2">
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => void save()}>
        Save conversation to Vault
      </Button>
      <p className="text-xs text-kumo-subtle">
        Saves text since the latest context checkpoint. Generated files, attachments and app state
        are not included.
      </p>
      {status && (
        <p className="text-xs text-kumo-subtle" role="status">
          {status}
        </p>
      )}
    </div>
  );
};
