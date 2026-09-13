import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageRow } from "@/lib/cache/local-cache";

const loadMessagesForSession = vi.fn();
const syncMessagesForSession = vi.fn();

vi.mock("@/lib/config/platform", () => ({
  isChromeExtension: () => false,
}));
vi.mock("@/lib/utils", () => ({
  isTauri: () => true,
}));
vi.mock("@/lib/backend", () => ({
  getBackend: () => ({ kind: "cloud_api" }),
}));
vi.mock("@/lib/cache/local-cache", () => ({
  loadMessagesForSession: (...args: unknown[]) => loadMessagesForSession(...args),
}));
vi.mock("@/lib/sync/message-sync", () => ({
  syncMessagesForSession: (...args: unknown[]) => syncMessagesForSession(...args),
}));
vi.mock("@/lib/diagnostics/extension-msg-diag", () => ({
  logExtMsgDiag: () => {},
  summarizeProtosForExtDiag: () => ({}),
}));

import { loadSessionMessageHistory } from "@/lib/messages/load-session-message-history";
import { useSessionMessageStore } from "@/stores/session-message-store";

function row(id: string, content = id, partsJson?: string): MessageRow {
  const at = "2024-01-01T00:00:00Z";
  return {
    id,
    teamId: "team-1",
    sessionId: "sess-1",
    kind: "agent_reply",
    content,
    origin: "cloud_api",
    createdAt: at,
    updatedAt: at,
    syncedAt: at,
    ...(partsJson ? { partsJson } : {}),
  };
}

const open = () => loadSessionMessageHistory({ sessionId: "sess-1", teamId: "team-1" });
const shown = () => useSessionMessageStore.getState().messages["sess-1"];

describe("loadSessionMessageHistory (Tauri path)", () => {
  beforeEach(() => {
    loadMessagesForSession.mockReset();
    syncMessagesForSession.mockReset();
    syncMessagesForSession.mockResolvedValue(0);
    useSessionMessageStore.setState({ messages: {} });
  });

  it("reopening a session whose cache has not changed keeps what is shown", async () => {
    loadMessagesForSession.mockResolvedValue([row("m1"), row("m2")]);

    await open();
    const first = shown();
    await open();

    expect(first?.map((m) => m.messageId)).toEqual(["m1", "m2"]);
    expect(shown()).toBe(first);
  });

  it("a changed row replaces what is shown", async () => {
    loadMessagesForSession
      .mockResolvedValueOnce([row("m1")])
      .mockResolvedValueOnce([row("m1", "edited")]);

    await open();
    const first = shown();
    await open();

    expect(shown()).not.toBe(first);
    expect(shown()?.[0]?.content).toBe("edited");
  });

  it("parts written to the cache after a turn still reach the store", async () => {
    loadMessagesForSession
      .mockResolvedValueOnce([row("m1")])
      .mockResolvedValueOnce([row("m1", "m1", '[{"type":"text","text":"done"}]')]);

    await open();
    const first = shown();
    await open();

    expect(shown()).not.toBe(first);
  });

  it("a sync whose rows change nothing leaves the thread alone", async () => {
    loadMessagesForSession.mockResolvedValue([row("m1")]);
    syncMessagesForSession.mockResolvedValue(1);

    await open();
    const first = shown();
    await open();

    expect(loadMessagesForSession).toHaveBeenCalledTimes(4);
    expect(shown()).toBe(first);
  });
});
