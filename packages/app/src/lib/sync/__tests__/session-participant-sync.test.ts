import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  listSessionParticipantsForSync: vi.fn(),
  loadSessionParticipants: vi.fn(),
  upsertSessionParticipantsBatch: vi.fn(async () => {}),
  softDeleteSessionParticipant: vi.fn(async () => {}),
  getWatermark: vi.fn(async () => null as string | null),
  setWatermark: vi.fn(async () => {}),
}));

vi.mock("@/lib/utils", () => ({ isTauri: mocks.isTauri }));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    sync: { listSessionParticipantsForSync: mocks.listSessionParticipantsForSync },
  }),
}));

vi.mock("@/lib/cache/local-cache", () => ({
  loadSessionParticipants: mocks.loadSessionParticipants,
  upsertSessionParticipantsBatch: mocks.upsertSessionParticipantsBatch,
  softDeleteSessionParticipant: mocks.softDeleteSessionParticipant,
  getWatermark: mocks.getWatermark,
  setWatermark: mocks.setWatermark,
}));

import { syncParticipantsForSession } from "@/lib/sync/session-participant-sync";

function serverRow(id: string, actorId: string) {
  return {
    id,
    session_id: "session-1",
    actor_id: actorId,
    joined_at: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
  };
}

function cachedRow(id: string, actorId: string) {
  return {
    id,
    sessionId: "session-1",
    actorId,
    joinedAt: null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    deletedAt: null,
    syncedAt: "2026-08-01T00:00:00Z",
  };
}

describe("syncParticipantsForSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isTauri.mockReturnValue(true);
    mocks.getWatermark.mockResolvedValue(null);
    mocks.loadSessionParticipants.mockResolvedValue([]);
  });

  it("drops local rows the server no longer has on a full sync", async () => {
    // Removal is a hard DELETE server-side, so the row just stops appearing.
    // Without reconciliation the removed actor lived on in the cache and came
    // back the next time the session was opened.
    mocks.listSessionParticipantsForSync.mockResolvedValue([serverRow("p1", "agent-1")]);
    mocks.loadSessionParticipants.mockResolvedValue([
      cachedRow("p1", "agent-1"),
      cachedRow("p2", "member-removed"),
    ]);

    await syncParticipantsForSession("session-1", "team-1", { full: true });

    expect(mocks.softDeleteSessionParticipant).toHaveBeenCalledTimes(1);
    expect(mocks.softDeleteSessionParticipant.mock.calls[0][0]).toBe("p2");
  });

  it("reconciles even when the server returns nobody", async () => {
    mocks.listSessionParticipantsForSync.mockResolvedValue([]);
    mocks.loadSessionParticipants.mockResolvedValue([cachedRow("p1", "agent-1")]);

    await syncParticipantsForSession("session-1", "team-1", { full: true });

    expect(mocks.softDeleteSessionParticipant).toHaveBeenCalledTimes(1);
    expect(mocks.softDeleteSessionParticipant.mock.calls[0][0]).toBe("p1");
  });

  it("leaves the cache alone on a delta sync", async () => {
    // A delta pull only carries rows touched since the watermark; the rows it
    // omits are not gone, they are merely unchanged.
    mocks.getWatermark.mockResolvedValue("2026-08-01T00:00:00Z");
    mocks.listSessionParticipantsForSync.mockResolvedValue([]);
    mocks.loadSessionParticipants.mockResolvedValue([cachedRow("p1", "agent-1")]);

    await syncParticipantsForSession("session-1", "team-1");

    expect(mocks.softDeleteSessionParticipant).not.toHaveBeenCalled();
  });

  it("never reconciles when the pull failed", async () => {
    // A network error must not be read as "the server has nobody" — that would
    // empty the roster of every session the user opened while offline.
    mocks.listSessionParticipantsForSync.mockRejectedValue(new Error("offline"));
    mocks.loadSessionParticipants.mockResolvedValue([cachedRow("p1", "agent-1")]);

    const count = await syncParticipantsForSession("session-1", "team-1", { full: true });

    expect(count).toBe(0);
    expect(mocks.softDeleteSessionParticipant).not.toHaveBeenCalled();
  });
});
