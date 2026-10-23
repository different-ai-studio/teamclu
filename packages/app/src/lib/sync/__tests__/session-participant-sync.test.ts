import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  listSessionParticipantsForSync: vi.fn(),
  replaceSessionParticipants: vi.fn(async () => {}),
}));

vi.mock("@/lib/utils", () => ({ isTauri: mocks.isTauri }));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    sync: { listSessionParticipantsForSync: mocks.listSessionParticipantsForSync },
  }),
}));

vi.mock("@/lib/cache/local-cache", () => ({
  replaceSessionParticipants: mocks.replaceSessionParticipants,
}));

import { syncParticipantsForSession } from "@/lib/sync/session-participant-sync";

function serverRow(id: string, actorId: string, updatedAt = "2026-08-01T00:00:00Z") {
  return {
    id,
    session_id: "session-1",
    actor_id: actorId,
    joined_at: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: updatedAt,
  };
}

describe("syncParticipantsForSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isTauri.mockReturnValue(true);
  });

  it("replaces the session with the cloud snapshot", async () => {
    mocks.listSessionParticipantsForSync.mockResolvedValue([
      serverRow("uuid-me", "me", "2026-08-01T00:00:00Z"),
      serverRow("uuid-agent", "agent", "2026-08-01T00:00:01Z"),
    ]);

    const count = await syncParticipantsForSession("session-1", "team-1");

    expect(count).toBe(2);
    expect(mocks.listSessionParticipantsForSync).toHaveBeenCalledWith("session-1", null);
    expect(mocks.replaceSessionParticipants).toHaveBeenCalledTimes(1);
    const [sessionId, rows] = mocks.replaceSessionParticipants.mock.calls[0];
    expect(sessionId).toBe("session-1");
    expect(rows).toEqual([
      expect.objectContaining({
        id: "uuid-me",
        sessionId: "session-1",
        actorId: "me",
        deletedAt: null,
      }),
      expect.objectContaining({
        id: "uuid-agent",
        sessionId: "session-1",
        actorId: "agent",
        deletedAt: null,
      }),
    ]);
  });

  it("replaces with an empty snapshot when the cloud roster is empty", async () => {
    mocks.listSessionParticipantsForSync.mockResolvedValue([]);

    const count = await syncParticipantsForSession("session-1", "team-1");

    expect(count).toBe(0);
    expect(mocks.replaceSessionParticipants).toHaveBeenCalledWith("session-1", []);
  });

  it("leaves the cache alone when the pull failed", async () => {
    mocks.listSessionParticipantsForSync.mockRejectedValue(new Error("offline"));

    const count = await syncParticipantsForSession("session-1", "team-1");

    expect(count).toBe(0);
    expect(mocks.replaceSessionParticipants).not.toHaveBeenCalled();
  });

  it("leaves the cache alone when the snapshot is truncated", async () => {
    mocks.listSessionParticipantsForSync.mockRejectedValue(
      new Error("stopping short — this delta is incomplete."),
    );

    const count = await syncParticipantsForSession("session-1", "team-1");

    expect(count).toBe(0);
    expect(mocks.replaceSessionParticipants).not.toHaveBeenCalled();
  });
});
