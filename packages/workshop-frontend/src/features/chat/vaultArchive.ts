import type { AiChatHistoryPage, Overseer } from "@gadgets/workshop-shared/api";

const PROTOCOL = "mikaki-archive-v1";

export const vaultDestination = (value: unknown): URL | null => {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== "/vault" ||
      url.search ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    )
      return null;
    return url;
  } catch {
    return null;
  }
};

export const makeVaultArchive = (
  page: AiChatHistoryPage,
  details: {
    origin: string;
    workspaceId: string;
    chatId: number;
    title: string;
  },
): string => {
  if (
    !/^[A-Za-z0-9_-]{1,256}$/.test(details.workspaceId) ||
    !Number.isSafeInteger(details.chatId) ||
    details.chatId < 0 ||
    !details.title.trim() ||
    details.title.length > 256 ||
    page.messages.length > 2000
  )
    throw new Error("This conversation segment cannot be saved.");
  const messages: {
    source_id: string;
    speaker: string;
    actor: "human" | "ai";
    text: string;
    timestamp: string;
  }[] = [];
  let previous = -1;
  for (const message of page.messages) {
    if (
      message.chatId !== details.chatId ||
      !Number.isSafeInteger(message.sequence) ||
      message.sequence <= previous
    )
      throw new Error("The conversation changed. Refresh and try again.");
    previous = message.sequence;
    if (message.type !== "message" || message.author.type === "gadget" || !message.message)
      continue;
    if (!message.author.name.trim() || message.author.name.length > 128)
      throw new Error("Invalid speaker name.");
    messages.push({
      source_id: String(message.sequence),
      speaker: message.author.name,
      actor: message.author.type === "user" ? "human" : "ai",
      text: message.message,
      timestamp: message.timestamp.toISOString(),
    });
  }
  if (!messages.length || messages.length > 200)
    throw new Error("Choose a segment with 1–200 text messages.");
  const archive = JSON.stringify({
    format_version: 2,
    source: {
      app: "cloudflare-os",
      origin: details.origin,
      workspace_id: details.workspaceId,
      chat_id: details.chatId,
      first_sequence: Number(messages[0].source_id),
      last_sequence: Number(messages.at(-1)!.source_id),
      scope: "text-segment",
    },
    title: details.title,
    messages,
  });
  if (new TextEncoder().encode(archive).length > 24000)
    throw new Error("This segment is too large for a Vault record.");
  return archive;
};

/** Open from a user click, pin the recipient window/origin, and await its post-commit receipt. */
export const sendVaultArchive = (
  destination: URL,
  makeArchive: () => Promise<string>,
  signal: AbortSignal,
  host: Window = window,
): Promise<void> => {
  const popup = host.open(destination.href, "_blank", "popup,width=720,height=840");
  if (!popup) return Promise.reject(new Error("Allow pop-ups to open Mikaki."));
  const channel = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let active = true,
      requested = false,
      delivered = false;
    const finish = (error?: Error) => {
      if (!active) return;
      active = false;
      clearInterval(poll);
      clearTimeout(timeout);
      host.removeEventListener("message", receive);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(new Error("Saving was cancelled."));
    const receive = (event: MessageEvent) => {
      if (
        !active ||
        signal.aborted ||
        event.source !== popup ||
        event.origin !== destination.origin
      )
        return;
      const data = event.data;
      if (
        !data ||
        typeof data !== "object" ||
        data.protocol !== PROTOCOL ||
        data.channel !== channel
      )
        return;
      if (data.type === "saved" && delivered) finish();
      if (data.type !== "request" || requested) return;
      requested = true;
      void makeArchive()
        .then((archive) => {
          if (!active || signal.aborted) return;
          delivered = true;
          popup.postMessage(
            { protocol: PROTOCOL, type: "archive", channel, archive },
            destination.origin,
          );
        })
        .catch((error) =>
          finish(error instanceof Error ? error : new Error("The conversation could not be read.")),
        );
    };
    const poll = setInterval(() => {
      if (popup.closed) {
        finish(new Error("Mikaki was closed before saving was confirmed."));
        return;
      }
      if (!requested)
        popup.postMessage({ protocol: PROTOCOL, type: "offer", channel }, destination.origin);
    }, 750);
    const timeout = setTimeout(
      () => finish(new Error("Saving timed out. Return to Mikaki to check the result.")),
      300_000,
    );
    host.addEventListener("message", receive);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
};

export type VaultArchiveReader = Pick<Overseer, "getChatHistory">;
