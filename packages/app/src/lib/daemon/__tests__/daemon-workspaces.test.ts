import { describe, it, expect, vi, beforeEach } from "vitest";

const { updateDaemonWorkspaceMock, loadSessionIdsForWorkspace, archiveSession } = vi.hoisted(() => ({
  updateDaemonWorkspaceMock: vi.fn(),
  loadSessionIdsForWorkspace: vi.fn(),
  archiveSession: vi.fn(),
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    workspaces: {
      updateDaemonWorkspace: updateDaemonWorkspaceMock,
    },
  }),
}));

vi.mock("@/lib/session/session-by-workspace", () => ({ loadSessionIdsForWorkspace }));

vi.mock("@/stores/session-list-store", () => ({
  useSessionListStore: {
    getState: () => ({ archiveSession }),
  },
}));

import { updateDaemonWorkspace } from "@/lib/daemon/daemon-workspaces";

describe("updateDaemonWorkspace", () => {
  beforeEach(() => {
    updateDaemonWorkspaceMock.mockReset();
    loadSessionIdsForWorkspace.mockReset();
    archiveSession.mockReset();
  });

  it("archives linked sessions when workspace is archived", async () => {
    updateDaemonWorkspaceMock.mockResolvedValueOnce({
      id: "ws1",
      team_id: "teamA",
      agent_id: null,
      created_by_member_id: null,
      name: "Alpha",
      path: "/tmp/alpha",
      archived: true,
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-01T00:00:00Z",
    });
    loadSessionIdsForWorkspace.mockResolvedValueOnce(new Set(["s1", "s2"]));
    archiveSession.mockResolvedValue(undefined);

    const out = await updateDaemonWorkspace({
      workspaceId: "ws1",
      name: "Alpha",
      path: "/tmp/alpha",
      archived: true,
    });

    expect(out.archived).toBe(true);
    expect(loadSessionIdsForWorkspace).toHaveBeenCalledWith("teamA", {
      workspaceId: "ws1",
      path: "/tmp/alpha",
    });
    expect(archiveSession).toHaveBeenCalledTimes(2);
    expect(archiveSession).toHaveBeenCalledWith("s1");
    expect(archiveSession).toHaveBeenCalledWith("s2");
  });

  it("does not archive sessions when workspace is unarchived", async () => {
    updateDaemonWorkspaceMock.mockResolvedValueOnce({
      id: "ws1",
      team_id: "teamA",
      agent_id: null,
      created_by_member_id: null,
      name: "Alpha",
      path: "/tmp/alpha",
      archived: false,
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-01T00:00:00Z",
    });

    await updateDaemonWorkspace({
      workspaceId: "ws1",
      name: "Alpha",
      path: "/tmp/alpha",
      archived: false,
    });

    expect(loadSessionIdsForWorkspace).not.toHaveBeenCalled();
    expect(archiveSession).not.toHaveBeenCalled();
  });
});
