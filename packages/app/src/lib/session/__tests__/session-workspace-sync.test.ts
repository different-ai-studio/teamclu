import { describe, it, expect, vi, beforeEach } from "vitest";

const { loadViewerWorkspaceContext, invalidateViewerWorkspaceContext } = vi.hoisted(() => ({
  loadViewerWorkspaceContext: vi.fn(),
  invalidateViewerWorkspaceContext: vi.fn(),
}));

vi.mock("@/lib/session/session-viewer-workspace", () => ({
  loadViewerWorkspaceContext,
  invalidateViewerWorkspaceContext,
}));

import { syncSessionWorkspaces } from "@/lib/session/session-workspace-sync";

/**
 * This used to prefetch every session → workspace link in the team by pulling
 * the whole `agent_runtimes` list — the query that reached 1306 rows and a 48KB
 * PostgREST URL. The workspace belongs to the participant row now (ADR-0005),
 * so links are resolved per session on demand and nothing is prefetched.
 *
 * What is left is cache invalidation, which is what these tests cover.
 */
describe("syncSessionWorkspaces", () => {
  beforeEach(() => {
    loadViewerWorkspaceContext.mockReset();
    invalidateViewerWorkspaceContext.mockReset();
    loadViewerWorkspaceContext.mockResolvedValue({
      memberId: "member-b",
      localDaemonAgentId: "agent-local",
      ownedAgentIds: new Set(["agent-local"]),
      localWorkspacesByCloudId: new Map(),
    });
  });

  it("invalidates before reloading so newly connected agents are picked up", async () => {
    await syncSessionWorkspaces("team-1");

    expect(invalidateViewerWorkspaceContext).toHaveBeenCalledWith("team-1");
    expect(loadViewerWorkspaceContext).toHaveBeenCalledWith("team-1");
    // Order matters: reloading a context that was never invalidated returns the
    // cached copy, which is what this function exists to avoid.
    expect(invalidateViewerWorkspaceContext.mock.invocationCallOrder[0]).toBeLessThan(
      loadViewerWorkspaceContext.mock.invocationCallOrder[0],
    );
  });

  it("does not fetch any team-wide runtime list", async () => {
    // Guards the regression this change exists to prevent: a bulk prefetch
    // reappearing here would put every session id back into one URL.
    await syncSessionWorkspaces("team-1");
    expect(loadViewerWorkspaceContext).toHaveBeenCalledTimes(1);
  });
});
