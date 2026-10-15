import { afterEach, describe, expect, it, vi } from "vitest";
import { makeVaultArchive, sendVaultArchive, vaultDestination } from "./vaultArchive";
import type { AiChatHistoryPage } from "@gadgets/workshop-shared/api";

const page: AiChatHistoryPage = {
  messages: [
    {
      chatId: 0,
      sequence: 1,
      type: "message",
      message: "Private question",
      timestamp: new Date("2026-10-14T00:00:00.000Z"),
      author: { type: "user", id: "owner", name: "Alice" },
    },
    {
      chatId: 0,
      sequence: 2,
      type: "message",
      message: "Private answer",
      reasoning: "Do not archive this",
      timestamp: new Date("2026-10-14T00:00:01.000Z"),
      author: { type: "agent", id: "model", name: "Assistant" },
    },
  ],
  compacted: { to: 1, summary: "Earlier private context" },
};
const details = {
  origin: "https://os.example",
  workspaceId: "workspace",
  chatId: 0,
  title: "Application discussion",
};
afterEach(() => vi.useRealTimers());
describe("Vault text-segment export", () => {
  it("retains source IDs, actor types and timestamps without reasoning or a false full-history claim", () => {
    const result = JSON.parse(makeVaultArchive(page, details));
    expect(result.source).toEqual({
      app: "cloudflare-os",
      origin: details.origin,
      workspace_id: "workspace",
      chat_id: 0,
      first_sequence: 1,
      last_sequence: 2,
      scope: "text-segment",
    });
    expect(result.messages.map((message: { actor: string }) => message.actor)).toEqual([
      "human",
      "ai",
    ]);
    expect(JSON.stringify(result)).not.toContain("Do not archive this");
    expect(JSON.stringify(result)).not.toContain("Earlier private context");
  });
  it("rejects oversized text and mismatched, duplicate or reordered source messages", () => {
    for (const messages of [
      [{ ...page.messages[0], chatId: 1 }],
      [page.messages[0], page.messages[0]],
      page.messages.toReversed(),
      [{ ...page.messages[0], type: "message", message: "猫".repeat(8001) }],
    ])
      expect(() => makeVaultArchive({ messages } as AiChatHistoryPage, details)).toThrow(
        /conversation|segment/,
      );
  });
  it("requires an exact Vault destination, with HTTP only for loopback development", () => {
    expect(vaultDestination("http://localhost:8787/vault")).not.toBeNull();
    for (const url of [
      "https://user:secret@example/vault",
      "http://example/vault",
      "https://example/other",
      "https://example/vault?secret=x",
      "https://example/vault#x",
    ])
      expect(vaultDestination(url)).toBeNull();
  });
  it("pins the popup and origin and accepts success only after the requested archive was sent", async () => {
    vi.useFakeTimers();
    let listener: ((event: MessageEvent) => void) | undefined;
    const sent: Record<string, unknown>[] = [];
    const popup = {
      closed: false,
      postMessage: (data: Record<string, unknown>, origin: string) => {
        expect(origin).toBe("https://mikaki.example");
        sent.push(data);
      },
    };
    const host = {
      open: vi.fn<() => typeof popup>(() => popup),
      addEventListener: (_: string, fn: (event: MessageEvent) => void) => {
        listener = fn;
      },
      removeEventListener: vi.fn<() => void>(),
    };
    const make = vi.fn<() => Promise<string>>(async () => makeVaultArchive(page, details));
    const result = sendVaultArchive(
      new URL("https://mikaki.example/vault"),
      make,
      new AbortController().signal,
      host as unknown as Window,
    );
    let saved = false;
    void result.then(() => {
      saved = true;
    });
    await vi.advanceTimersByTimeAsync(750);
    const offer = sent[0];
    const receive = (type: string, origin = "https://mikaki.example", source: unknown = popup) =>
      listener!({ origin, source, data: { ...offer, type } } as MessageEvent);
    receive("saved");
    await Promise.resolve();
    expect(saved).toBe(false);
    receive("request", "https://evil.example");
    receive("request", "https://mikaki.example", {});
    expect(make).not.toHaveBeenCalled();
    receive("request");
    receive("request");
    await vi.advanceTimersByTimeAsync(0);
    expect(make).toHaveBeenCalledTimes(1);
    expect(sent[1].type).toBe("archive");
    receive("saved");
    await result;
    expect(saved).toBe(true);
    expect(host.removeEventListener).toHaveBeenCalled();
  });
  it("cancels the handoff when the source view is closed", async () => {
    vi.useFakeTimers();
    const host = {
      open: () => ({ closed: false }),
      addEventListener: vi.fn<() => void>(),
      removeEventListener: vi.fn<() => void>(),
    };
    const control = new AbortController();
    const result = sendVaultArchive(
      new URL("https://mikaki.example/vault"),
      async () => "",
      control.signal,
      host as unknown as Window,
    );
    control.abort();
    await expect(result).rejects.toThrow("cancelled");
  });
});
