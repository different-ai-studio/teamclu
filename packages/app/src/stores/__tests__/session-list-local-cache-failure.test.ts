import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The local cache is an accelerator, never a gate. These tests pin the
 * contract that a rejecting local_cache command (in practice: the current-team
 * gate disagreeing with the team being loaded) can no longer strand the list
 * with `loading: true` — the failure mode that produced a permanently spinning
 * sidebar and the highest-volume unhandled rejection in Sentry.
 */

const mocks = vi.hoisted(() => ({
  listCurrentActorSessions: vi.fn(),
  loadSessionsForTeam: vi.fn(),
  loadSessionIdsForActor: vi.fn(),
  upsertSessionsBatch: vi.fn(),
  syncSessionWorkspaces: vi.fn(),
  reportLocalCacheFailure: vi.fn(),
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    sessions: {
      listCurrentActorSessions: mocks.listCurrentActorSessions,
      markCurrentActorSessionViewed: vi.fn(),
      updateSessionTitle: vi.fn(),
      archiveSession: vi.fn(),
    },
  }),
}));

vi.mock("@/lib/utils", () => ({ isTauri: () => true }));

vi.mock("@/lib/cache/local-cache", () => ({
  loadSessionsForTeam: (...args: unknown[]) => mocks.loadSessionsForTeam(...args),
  loadSessionIdsForActor: (...args: unknown[]) => mocks.loadSessionIdsForActor(...args),
  upsertSessionsBatch: (...args: unknown[]) => mocks.upsertSessionsBatch(...args),
  softDeleteSession: vi.fn(),
}));

vi.mock("@/lib/session/session-workspace-sync", () => ({
  syncSessionWorkspaces: (...args: unknown[]) => mocks.syncSessionWorkspaces(...args),
}));

vi.mock("@/lib/extension/link-session", () => ({
  removeLinkSessionEntriesForSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/telemetry/local-cache-error-report", () => ({
  reportLocalCacheFailure: (...args: unknown[]) => mocks.reportLocalCacheFailure(...args),
}));

vi.mock("../current-team", () => ({
  useCurrentTeamStore: { getState: () => ({ team: { id: "team-1" }, currentMember: { id: "actor-1" } }) },
}));

// The failing-RPC case below toasts; keep that off the real toaster/i18n.
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/lib/i18n", () => ({ default: { t: (key: string) => key } }));

const serverRow = {
  id: "session-1",
  title: "Session",
  team_id: "team-1",
  mode: "collab",
  idea_id: null,
  last_message_at: "2026-07-28T08:00:00.000Z",
  last_message_preview: "preview",
  created_at: "2026-07-28T07:59:00.000Z",
  updated_at: "2026-07-28T08:00:01.000Z",
  has_unread: false,
};

const GATE_ERROR = new Error(
  "local_cache: team gate mismatch in session batch (current=team-2, row_team=team-1)",
);

async function freshStore() {
  const { useSessionListStore } = await import("../session-list-store");
  useSessionListStore.setState({
    rows: [],
    loading: false,
    error: null,
    pinnedSessionIds: [],
    highlightedSessionIds: [],
    hasMore: false,
    nextCursor: null,
    serverConfirmed: false,
  });
  const { useAuthStore } = await import("../auth-store");
  useAuthStore.setState({ session: { user: { id: "user-1" } } } as never);
  return useSessionListStore;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.loadSessionsForTeam.mockResolvedValue([]);
  mocks.loadSessionIdsForActor.mockResolvedValue([]);
  mocks.upsertSessionsBatch.mockResolvedValue(undefined);
  mocks.syncSessionWorkspaces.mockResolvedValue(undefined);
  mocks.listCurrentActorSessions.mockResolvedValue({ rows: [serverRow], nextCursor: null });
});

describe("loadFirstPage local-cache resilience", () => {
  it("still renders server rows and clears loading when the cache hydrate rejects", async () => {
    mocks.loadSessionsForTeam.mockRejectedValueOnce(GATE_ERROR);
    const store = await freshStore();

    await expect(store.getState().loadFirstPage()).resolves.toBeUndefined();

    expect(store.getState().loading).toBe(false);
    expect(store.getState().rows.map((r) => r.id)).toEqual(["session-1"]);
    expect(mocks.reportLocalCacheFailure).toHaveBeenCalledWith(
      "session_load_team",
      GATE_ERROR,
      { teamId: "team-1" },
    );
  });

  it("still renders server rows and clears loading when the cache write rejects", async () => {
    mocks.upsertSessionsBatch.mockRejectedValueOnce(GATE_ERROR);
    const store = await freshStore();

    await expect(store.getState().loadFirstPage()).resolves.toBeUndefined();

    expect(store.getState().loading).toBe(false);
    expect(store.getState().rows.map((r) => r.id)).toEqual(["session-1"]);
    expect(mocks.reportLocalCacheFailure).toHaveBeenCalledWith(
      "session_upsert_batch",
      GATE_ERROR,
      { teamId: "team-1" },
    );
  });

  it("keeps the RPC error path intact — a failing server call still surfaces", async () => {
    mocks.listCurrentActorSessions.mockRejectedValueOnce(new Error("boom"));
    const store = await freshStore();

    await store.getState().loadFirstPage();

    expect(store.getState().loading).toBe(false);
    expect(store.getState().error).toBe("boom");
  });

  it("keeps only current-actor cached sessions when the network list fails", async () => {
    mocks.loadSessionsForTeam.mockResolvedValueOnce([
      {
        id: "mine",
        teamId: "team-1",
        title: "My empty session",
        mode: "collab",
        lastMessageAt: null,
        createdAt: "2026-07-28T08:00:00.000Z",
        updatedAt: "2026-07-28T08:00:00.000Z",
        syncedAt: "2026-07-28T08:00:00.000Z",
      },
      {
        id: "teammate",
        teamId: "team-1",
        title: "Teammate session",
        mode: "collab",
        lastMessageAt: "2026-07-28T08:00:00.000Z",
        createdAt: "2026-07-28T07:59:00.000Z",
        updatedAt: "2026-07-28T08:00:00.000Z",
        syncedAt: "2026-07-28T08:00:00.000Z",
      },
    ]);
    mocks.loadSessionIdsForActor.mockResolvedValueOnce(["mine"]);
    mocks.listCurrentActorSessions.mockRejectedValueOnce(new Error("boom"));
    const store = await freshStore();

    await store.getState().loadFirstPage();

    expect(mocks.loadSessionIdsForActor).toHaveBeenCalledWith("team-1", "actor-1");
    expect(store.getState().rows.map((row) => row.id)).toEqual(["mine"]);
    expect(store.getState().error).toBe("boom");
  });
});
