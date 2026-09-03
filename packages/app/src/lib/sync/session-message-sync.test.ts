import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  backend: {
    kind: "supabase",
    sessions: {
      listSessionsForTeamSince: vi.fn(),
    },
    messages: {
      listMessagesForSessionSince: vi.fn(),
    },
  },
  getBackend: vi.fn(),
  getWatermark: vi.fn(),
  setWatermark: vi.fn(),
  upsertSessionsBatch: vi.fn(),
  upsertMessagesBatch: vi.fn(),
  isTauri: vi.fn(),
}));

vi.mock("@/lib/backend", () => ({
  getBackend: mocks.getBackend,
}));

vi.mock("@/lib/cache/local-cache", () => ({
  getWatermark: mocks.getWatermark,
  setWatermark: mocks.setWatermark,
  upsertSessionsBatch: mocks.upsertSessionsBatch,
  upsertMessagesBatch: mocks.upsertMessagesBatch,
}));

vi.mock("@/lib/utils", () => ({
  isTauri: mocks.isTauri,
}));

import { syncMessagesForSession } from "@/lib/sync/message-sync";
import { syncSessionsForTeam } from "@/lib/sync/session-sync";
import type { MessageSyncRow, SessionSyncRow } from "@/lib/backend/types";

describe("session and message cache sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBackend.mockReturnValue(mocks.backend);
    mocks.isTauri.mockReturnValue(true);
  });

  it("does not sync sessions outside Tauri", async () => {
    mocks.isTauri.mockReturnValue(false);

    await expect(syncSessionsForTeam("team-1")).resolves.toBe(0);

    expect(mocks.getWatermark).not.toHaveBeenCalled();
    expect(mocks.getBackend).not.toHaveBeenCalled();
    expect(mocks.upsertSessionsBatch).not.toHaveBeenCalled();
  });

  it("does not sync messages outside Tauri", async () => {
    mocks.isTauri.mockReturnValue(false);

    await expect(syncMessagesForSession("session-1", "team-1")).resolves.toBe(0);

    expect(mocks.getWatermark).not.toHaveBeenCalled();
    expect(mocks.getBackend).not.toHaveBeenCalled();
    expect(mocks.upsertMessagesBatch).not.toHaveBeenCalled();
  });

  it("syncs team sessions through the backend facade and advances the watermark", async () => {
    mocks.getWatermark.mockResolvedValueOnce("2026-05-25T00:00:00.000Z");
    const sessionRows = [
      {
        id: "session-1",
        team_id: "team-1",
        title: "Alpha",
        mode: "collab",
        primary_agent_id: "agent-1",
        idea_id: "idea-1",
        summary: "Summary",
        last_message_preview: "Preview",
        last_message_at: "2026-05-25T00:05:00.000Z",
        created_by_actor_id: "actor-1",
        created_at: "2026-05-25T00:01:00.000Z",
        updated_at: "2026-05-25T00:10:00.000Z",
      },
      {
        id: "session-2",
        team_id: "team-1",
        title: null,
        mode: null,
        primary_agent_id: null,
        idea_id: null,
        summary: null,
        last_message_preview: null,
        last_message_at: null,
        created_by_actor_id: null,
        created_at: "2026-05-25T00:02:00.000Z",
        updated_at: "2026-05-25T00:20:00.000Z",
      },
    ] satisfies SessionSyncRow[];
    mocks.backend.sessions.listSessionsForTeamSince.mockResolvedValueOnce(sessionRows);

    await expect(syncSessionsForTeam("team-1")).resolves.toBe(2);

    expect(mocks.getWatermark).toHaveBeenCalledWith("sessions", "team-1");
    expect(mocks.backend.sessions.listSessionsForTeamSince).toHaveBeenCalledWith(
      "team-1",
      "2026-05-25T00:00:00.000Z",
    );
    expect(mocks.upsertSessionsBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "session-1",
        teamId: "team-1",
        title: "Alpha",
        mode: "collab",
        primaryAgentId: "agent-1",
        ideaId: "idea-1",
        summary: "Summary",
        lastMessagePreview: "Preview",
        lastMessageAt: "2026-05-25T00:05:00.000Z",
        createdBy: "actor-1",
        metadataJson: null,
        createdAt: "2026-05-25T00:01:00.000Z",
        updatedAt: "2026-05-25T00:10:00.000Z",
        deletedAt: null,
      }),
      expect.objectContaining({
        id: "session-2",
        teamId: "team-1",
        title: null,
        mode: null,
        primaryAgentId: null,
        ideaId: null,
        summary: null,
        lastMessagePreview: null,
        lastMessageAt: null,
        createdBy: null,
        updatedAt: "2026-05-25T00:20:00.000Z",
      }),
    ]);
    expect(mocks.setWatermark).toHaveBeenCalledWith(
      "sessions",
      "team-1",
      "2026-05-25T00:20:00.000Z",
    );
  });

  it("does a full session sync without reading the previous watermark", async () => {
    mocks.backend.sessions.listSessionsForTeamSince.mockResolvedValueOnce([]);

    await expect(syncSessionsForTeam("team-1", { full: true })).resolves.toBe(0);

    expect(mocks.getWatermark).not.toHaveBeenCalled();
    expect(mocks.backend.sessions.listSessionsForTeamSince).toHaveBeenCalledWith(
      "team-1",
      "",
    );
    expect(mocks.upsertSessionsBatch).not.toHaveBeenCalled();
    expect(mocks.setWatermark).not.toHaveBeenCalled();
  });

  it("returns 0 when the session backend pull fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.getWatermark.mockResolvedValueOnce("2026-05-25T00:00:00.000Z");
    mocks.backend.sessions.listSessionsForTeamSince.mockRejectedValueOnce(
      new Error("backend unavailable"),
    );

    await expect(syncSessionsForTeam("team-1")).resolves.toBe(0);

    expect(mocks.upsertSessionsBatch).not.toHaveBeenCalled();
    expect(mocks.setWatermark).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[session-sync] pull failed:",
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it("syncs session messages through the backend facade and preserves Supabase origin", async () => {
    mocks.getWatermark.mockResolvedValueOnce("2026-05-25T01:00:00.000Z");
    const messageRows = [
      {
        id: "message-1",
        team_id: "team-1",
        session_id: "session-1",
        turn_id: "turn-1",
        sender_actor_id: "actor-1",
        reply_to_message_id: null,
        kind: "text",
        content: "Hello",
        metadata: { tool: "search", count: 2 },
        model: "gpt-5",
        created_at: "2026-05-25T01:01:00.000Z",
        updated_at: "2026-05-25T01:05:00.000Z",
      },
      {
        id: "message-2",
        team_id: "team-1",
        session_id: "session-1",
        turn_id: null,
        sender_actor_id: null,
        reply_to_message_id: "message-1",
        kind: "text",
        content: "",
        metadata: "{\"kept\":\"string\"}",
        model: null,
        created_at: "2026-05-25T01:02:00.000Z",
        updated_at: "2026-05-25T01:10:00.000Z",
      },
    ] satisfies MessageSyncRow[];
    mocks.backend.messages.listMessagesForSessionSince.mockResolvedValueOnce(messageRows);

    await expect(syncMessagesForSession("session-1", "team-1")).resolves.toBe(2);

    expect(mocks.getWatermark).toHaveBeenCalledWith("messages:session-1", "team-1");
    expect(mocks.backend.messages.listMessagesForSessionSince).toHaveBeenCalledWith(
      "session-1",
      "2026-05-25T01:00:00.000Z",
    );
    expect(mocks.upsertMessagesBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "message-1",
        teamId: "team-1",
        sessionId: "session-1",
        turnId: "turn-1",
        senderActorId: "actor-1",
        replyToMessageId: null,
        kind: "text",
        content: "Hello",
        metadataJson: "{\"tool\":\"search\",\"count\":2}",
        model: "gpt-5",
        mentionsJson: null,
        origin: "supabase",
        createdAt: "2026-05-25T01:01:00.000Z",
        updatedAt: "2026-05-25T01:05:00.000Z",
        deletedAt: null,
      }),
      expect.objectContaining({
        id: "message-2",
        content: "",
        metadataJson: "{\"kept\":\"string\"}",
        origin: "supabase",
        updatedAt: "2026-05-25T01:10:00.000Z",
      }),
    ]);
    expect(mocks.setWatermark).toHaveBeenCalledWith(
      "messages:session-1",
      "team-1",
      "2026-05-25T01:10:00.000Z",
    );
  });

  it("returns 0 when the message backend pull fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.getWatermark.mockResolvedValueOnce("2026-05-25T01:00:00.000Z");
    mocks.backend.messages.listMessagesForSessionSince.mockRejectedValueOnce(
      new Error("backend unavailable"),
    );

    await expect(syncMessagesForSession("session-1", "team-1")).resolves.toBe(0);

    expect(mocks.upsertMessagesBatch).not.toHaveBeenCalled();
    expect(mocks.setWatermark).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[message-sync] pull failed:",
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it("does a full message sync without reading the previous watermark", async () => {
    mocks.getWatermark.mockResolvedValueOnce("2026-05-25T01:00:00.000Z");
    mocks.backend.messages.listMessagesForSessionSince.mockResolvedValueOnce([]);

    await expect(
      syncMessagesForSession("session-1", "team-1", { full: true }),
    ).resolves.toBe(0);

    expect(mocks.getWatermark).not.toHaveBeenCalled();
    expect(mocks.backend.messages.listMessagesForSessionSince).toHaveBeenCalledWith(
      "session-1",
      null,
    );
    expect(mocks.upsertMessagesBatch).not.toHaveBeenCalled();
    expect(mocks.setWatermark).not.toHaveBeenCalled();
  });
});
