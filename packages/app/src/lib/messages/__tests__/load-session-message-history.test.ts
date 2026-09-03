import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageRow } from "@/lib/cache/local-cache";
import type { MessageHistoryRow } from "@/lib/backend/types";

const platform = { tauri: false, extension: false };
const listMessages = vi.fn();
const loadMessagesForSession = vi.fn();
const upsertMessagesBatch = vi.fn();

vi.mock("@/lib/config/platform", () => ({
  isChromeExtension: () => platform.extension,
}));
vi.mock("@/lib/utils", () => ({
  isTauri: () => platform.tauri,
}));
vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    kind: "cloud_api",
    messages: { listMessages: (...args: unknown[]) => listMessages(...args) },
  }),
}));
vi.mock("@/lib/cache/local-cache", () => ({
  loadMessagesForSession: (...args: unknown[]) => loadMessagesForSession(...args),
  upsertMessagesBatch: (...args: unknown[]) => upsertMessagesBatch(...args),
}));
vi.mock("@/lib/diagnostics/extension-msg-diag", () => ({
  logExtMsgDiag: () => {},
  summarizeProtosForExtDiag: () => ({}),
}));

import {
  loadSessionMessageHistory,
  selectRowsNewerThanLocal,
} from "@/lib/messages/load-session-message-history";
import { useSessionMessageStore } from "@/stores/session-message-store";

function row(id: string, updatedAt: string, content = id): MessageRow {
  return {
    id,
    teamId: "team-1",
    sessionId: "sess-1",
    kind: "text",
    content,
    origin: "cloud_api",
    createdAt: updatedAt,
    updatedAt,
    syncedAt: updatedAt,
  };
}

function historyRow(id: string, updatedAt: string, content = id): MessageHistoryRow {
  return {
    id,
    team_id: "team-1",
    session_id: "sess-1",
    turn_id: null,
    sender_actor_id: null,
    reply_to_message_id: null,
    kind: "text",
    content,
    metadata: null,
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

describe("selectRowsNewerThanLocal", () => {
  it("returns everything when the cache is empty", () => {
    const pulled = [row("a", "2024-01-01T00:00:00Z")];
    expect(selectRowsNewerThanLocal(pulled, [])).toBe(pulled);
  });

  it("drops rows the cache already holds at the same or a newer instant", () => {
    const local = [
      row("same", "2024-01-01T00:00:00.000Z"),
      row("newer-locally", "2024-01-02T00:00:00Z"),
    ];
    const pulled = [
      // Same instant, different formatting: must compare as time, not text.
      row("same", "2024-01-01T00:00:00+00:00"),
      row("newer-locally", "2024-01-01T00:00:00Z"),
      row("changed", "2024-01-03T00:00:00Z"),
      row("unknown", "2024-01-01T00:00:00Z"),
    ];
    const local2 = [...local, row("changed", "2024-01-02T00:00:00Z")];
    expect(selectRowsNewerThanLocal(pulled, local2).map((r) => r.id)).toEqual([
      "changed",
      "unknown",
    ]);
  });

  it("keeps rows whose timestamps cannot be parsed", () => {
    const local = [row("x", "not a date")];
    const pulled = [row("x", "2024-01-01T00:00:00Z")];
    expect(selectRowsNewerThanLocal(pulled, local)).toHaveLength(1);
  });
});

describe("loadSessionMessageHistory (extension path)", () => {
  beforeEach(() => {
    platform.tauri = false;
    platform.extension = true;
    listMessages.mockReset();
    loadMessagesForSession.mockReset();
    upsertMessagesBatch.mockReset();
    upsertMessagesBatch.mockResolvedValue(undefined);
    useSessionMessageStore.setState({ messages: {} });
  });

  it("upserts only the rows the cache does not have yet", async () => {
    const cached = [row("m1", "2024-01-01T00:00:01Z"), row("m2", "2024-01-01T00:00:02Z")];
    loadMessagesForSession
      .mockResolvedValueOnce(cached)
      .mockResolvedValueOnce([...cached, row("m3", "2024-01-01T00:00:03Z")]);
    listMessages.mockResolvedValue({
      rows: [
        historyRow("m1", "2024-01-01T00:00:01Z"),
        historyRow("m2", "2024-01-01T00:00:02Z"),
        historyRow("m3", "2024-01-01T00:00:03Z"),
      ],
    });

    await loadSessionMessageHistory({ sessionId: "sess-1", teamId: "team-1" });

    expect(upsertMessagesBatch).toHaveBeenCalledTimes(1);
    const [written] = upsertMessagesBatch.mock.calls[0] as [MessageRow[]];
    expect(written.map((r) => r.id)).toEqual(["m3"]);
    expect(
      useSessionMessageStore.getState().messages["sess-1"]?.map((m) => m.messageId),
    ).toEqual(["m1", "m2", "m3"]);
  });

  it("skips the write and the reload when nothing changed", async () => {
    const cached = [row("m1", "2024-01-01T00:00:01Z")];
    loadMessagesForSession.mockResolvedValue(cached);
    listMessages.mockResolvedValue({ rows: [historyRow("m1", "2024-01-01T00:00:01Z")] });

    await loadSessionMessageHistory({ sessionId: "sess-1", teamId: "team-1" });

    expect(upsertMessagesBatch).not.toHaveBeenCalled();
    expect(loadMessagesForSession).toHaveBeenCalledTimes(1);
    expect(
      useSessionMessageStore.getState().messages["sess-1"]?.map((m) => m.messageId),
    ).toEqual(["m1"]);
  });

  it("still writes a first history into an empty cache", async () => {
    loadMessagesForSession
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row("m1", "2024-01-01T00:00:01Z")]);
    listMessages.mockResolvedValue({ rows: [historyRow("m1", "2024-01-01T00:00:01Z")] });

    await loadSessionMessageHistory({ sessionId: "sess-1", teamId: "team-1" });

    expect(upsertMessagesBatch).toHaveBeenCalledTimes(1);
    expect(loadMessagesForSession).toHaveBeenCalledTimes(2);
  });
});
