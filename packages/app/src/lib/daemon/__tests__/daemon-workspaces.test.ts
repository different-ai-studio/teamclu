import { describe, it, expect, vi, beforeEach } from "vitest";

const { updateDaemonWorkspaceMock, syncSessionsForTeam, load, archiveSession } = vi.hoisted(() => ({
  updateDaemonWorkspaceMock: vi.fn(),
  syncSessionsForTeam: vi.fn(),
  load: vi.fn(),
  archiveSession: vi.fn(),
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    workspaces: {
      updateDaemonWorkspace: updateDaemonWorkspaceMock,
    },
  }),
}));

vi.mock("@/lib/sync/session-sync", () => ({ syncSessionsForTeam }));

vi.mock("@/stores/session-list-store", () => ({
  useSessionListStore: {
    getState: () => ({ load, archiveSession }),
  },
}));

import { updateDaemonWorkspace } from "@/lib/daemon/daemon-workspaces";

function row(archived: boolean) {
  return {
    id: "ws1",
    team_id: "teamA",
    agent_id: null,
    created_by_member_id: null,
    name: "Alpha",
    path: "/tmp/alpha",
    archived,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
  };
}

describe("updateDaemonWorkspace", () => {
  beforeEach(() => {
    updateDaemonWorkspaceMock.mockReset();
    syncSessionsForTeam.mockReset().mockResolvedValue(0);
    load.mockReset().mockResolvedValue(undefined);
    archiveSession.mockReset();
  });

  // The Cloud API archives the sessions and stamps them with the workspace's
  // archive instant; a per-session PATCH from here would overwrite that stamp
  // and leave restoring the workspace nothing to match.
  it.each([true, false])("leaves session archival to the server and refreshes the list (archived=%s)", async (archived) => {
    updateDaemonWorkspaceMock.mockResolvedValueOnce(row(archived));

    const out = await updateDaemonWorkspace({
      workspaceId: "ws1",
      name: "Alpha",
      path: "/tmp/alpha",
      archived,
    });

    expect(out.archived).toBe(archived);
    expect(archiveSession).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(syncSessionsForTeam).toHaveBeenCalledWith("teamA");
  });

  it("does not fail the workspace update when the refresh fails", async () => {
    updateDaemonWorkspaceMock.mockResolvedValueOnce(row(true));
    syncSessionsForTeam.mockRejectedValueOnce(new Error("offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      updateDaemonWorkspace({ workspaceId: "ws1", name: "Alpha", path: "/tmp/alpha", archived: true }),
    ).resolves.toMatchObject({ archived: true });
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });
});
