import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  clearSessionCreatedByCacheForTests,
  getSessionCreatedByActorId,
  preloadSessionCreatedByActorId,
  rememberSessionCreatedByActorId,
  resolveSessionCreatedByActorId,
  seedSessionCreatedByFromRows,
} from "@/lib/session-created-by-cache";

const backendGetSession = vi.fn();
const loadSessionsForTeam = vi.fn();

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    sessions: { getSession: backendGetSession },
  }),
}));

vi.mock("@/lib/local-cache", () => ({
  loadSessionsForTeam: (...args: unknown[]) => loadSessionsForTeam(...args),
}));

beforeEach(() => {
  clearSessionCreatedByCacheForTests();
  backendGetSession.mockReset();
  loadSessionsForTeam.mockReset();
  loadSessionsForTeam.mockResolvedValue([]);
});

describe("session-created-by-cache", () => {
  it("returns remembered creator without hitting backend", async () => {
    rememberSessionCreatedByActorId("sess-1", "actor-1");

    await expect(resolveSessionCreatedByActorId("sess-1", "team-1")).resolves.toBe("actor-1");
    expect(backendGetSession).not.toHaveBeenCalled();
  });

  it("seeds from sync rows and serves from memory", () => {
    seedSessionCreatedByFromRows([
      { id: "sess-2", created_by_actor_id: "actor-2" },
    ]);
    expect(getSessionCreatedByActorId("sess-2")).toBe("actor-2");
  });

  it("preload is a no-op when creator is already cached", () => {
    rememberSessionCreatedByActorId("sess-3", "actor-3");
    preloadSessionCreatedByActorId("sess-3", "team-1");
    expect(backendGetSession).not.toHaveBeenCalled();
  });
});
