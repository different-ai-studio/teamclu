import { describe, it, expect, vi, beforeEach } from "vitest";

const { loadSessionWorkspacesForTeam } = vi.hoisted(() => ({
  loadSessionWorkspacesForTeam: vi.fn(),
}));
const { loadViewerWorkspaceContext, pickSessionWorkspaceLabel, resolveSessionWorkspaceForViewer } =
  vi.hoisted(() => ({
    loadViewerWorkspaceContext: vi.fn(),
    pickSessionWorkspaceLabel: vi.fn(),
    resolveSessionWorkspaceForViewer: vi.fn(),
  }));

vi.mock("@/lib/cache/local-cache", () => ({ loadSessionWorkspacesForTeam }));
vi.mock("@/lib/session/session-viewer-workspace", () => ({
  loadViewerWorkspaceContext,
  pickSessionWorkspaceLabel,
  resolveSessionWorkspaceForViewer,
}));

const workspaceStoreState = vi.hoisted(() => ({
  workspacePath: null as string | null,
  setWorkspace: vi.fn(async (path: string) => {
    workspaceStoreState.workspacePath = path;
  }),
}));
vi.mock("@/stores/workspace", () => ({
  useWorkspaceStore: {
    getState: () => workspaceStoreState,
  },
}));

import {
  loadSessionIdsForWorkspace,
  loadSessionWorkspaceLabelsForTeam,
  resolveSessionWorkspacePath,
  sessionBelongsToWorkspace,
  switchToSessionWorkspaceIfNeeded,
} from "@/lib/session/session-by-workspace";

const viewerCtx = {
  memberId: "member-a",
  localDaemonAgentId: "agent-local",
  ownedAgentIds: new Set(["agent-local"]),
  localWorkspacesByCloudId: new Map(),
};

describe("loadSessionIdsForWorkspace", () => {
  beforeEach(() => {
    loadSessionWorkspacesForTeam.mockReset();
    loadViewerWorkspaceContext.mockReset();
    loadViewerWorkspaceContext.mockResolvedValue(viewerCtx);
  });

  it("matches by workspaceId exactly for the current viewer", async () => {
    loadSessionWorkspacesForTeam.mockResolvedValue([
      {
        sessionId: "s1",
        teamId: "teamA",
        viewerMemberId: "member-a",
        agentId: "agent-local",
        workspaceId: "ws1",
        workspacePath: "/p/1",
        updatedAt: "2026-06-01T00:00:00Z",
      },
      {
        sessionId: "s2",
        teamId: "teamA",
        viewerMemberId: "member-a",
        agentId: "agent-local",
        workspaceId: "ws2",
        workspacePath: "/p/2",
        updatedAt: "2026-06-01T00:00:00Z",
      },
    ]);
    const ids = await loadSessionIdsForWorkspace("teamA", {
      workspaceId: "ws1",
      path: "/p/1",
    });
    expect(loadSessionWorkspacesForTeam).toHaveBeenCalledWith("teamA", "member-a");
    expect([...ids]).toEqual(["s1"]);
  });

  it("falls back to path match when workspaceId is null", async () => {
    loadSessionWorkspacesForTeam.mockResolvedValue([
      {
        sessionId: "s1",
        teamId: "teamA",
        viewerMemberId: "member-a",
        agentId: "agent-local",
        workspaceId: null,
        workspacePath: "/Users/me/proj/",
        updatedAt: "2026-06-01T00:00:00Z",
      },
    ]);
    const ids = await loadSessionIdsForWorkspace("teamA", {
      workspaceId: null,
      path: "/Users/me/proj",
    });
    expect([...ids]).toEqual(["s1"]);
  });

  it("returns empty set when viewer has no member id", async () => {
    loadViewerWorkspaceContext.mockResolvedValue({ ...viewerCtx, memberId: null });
    const ids = await loadSessionIdsForWorkspace("teamA", {
      workspaceId: "ws1",
      path: "/p/1",
    });
    expect(ids.size).toBe(0);
    expect(loadSessionWorkspacesForTeam).not.toHaveBeenCalled();
  });
});

describe("loadSessionWorkspaceLabelsForTeam", () => {
  beforeEach(() => {
    loadSessionWorkspacesForTeam.mockReset();
    loadViewerWorkspaceContext.mockReset();
    pickSessionWorkspaceLabel.mockReset();
    loadViewerWorkspaceContext.mockResolvedValue(viewerCtx);
  });

  it("builds labels via viewer-scoped picker", async () => {
    const rows = [
      {
        sessionId: "s1",
        teamId: "teamA",
        viewerMemberId: "member-a",
        agentId: "agent-local",
        workspacePath: "/Users/me/copilot-ws-v3",
        workspaceId: "ws1",
        updatedAt: "2026-06-01T00:00:00Z",
      },
    ];
    loadSessionWorkspacesForTeam.mockResolvedValue(rows);
    pickSessionWorkspaceLabel.mockReturnValue("copilot-ws-v3");

    const labels = await loadSessionWorkspaceLabelsForTeam("teamA");
    expect(pickSessionWorkspaceLabel).toHaveBeenCalledWith(rows, "s1", viewerCtx);
    expect(labels.get("s1")).toBe("copilot-ws-v3");
  });
});

describe("resolveSessionWorkspacePath", () => {
  beforeEach(() => resolveSessionWorkspaceForViewer.mockReset());

  it("delegates to viewer-scoped resolver", async () => {
    resolveSessionWorkspaceForViewer.mockResolvedValue("/Users/me/new");
    await expect(resolveSessionWorkspacePath("teamA", "s1")).resolves.toBe("/Users/me/new");
    expect(resolveSessionWorkspaceForViewer).toHaveBeenCalledWith("teamA", "s1");
  });
});

describe("sessionBelongsToWorkspace", () => {
  beforeEach(() => resolveSessionWorkspaceForViewer.mockReset());

  it("returns true when the session path matches the workspace", async () => {
    resolveSessionWorkspaceForViewer.mockResolvedValue("/Users/me/ws-b");
    await expect(
      sessionBelongsToWorkspace("teamA", "s-b", "/Users/me/ws-b"),
    ).resolves.toBe(true);
  });

  it("returns false when the session belongs to another workspace", async () => {
    resolveSessionWorkspaceForViewer.mockResolvedValue("/Users/me/ws-a");
    await expect(
      sessionBelongsToWorkspace("teamA", "s-a", "/Users/me/ws-b"),
    ).resolves.toBe(false);
  });

  it("returns false when the session has no viewer workspace binding", async () => {
    resolveSessionWorkspaceForViewer.mockResolvedValue(null);
    await expect(
      sessionBelongsToWorkspace("teamA", "s-obs", "/Users/me/ws-b"),
    ).resolves.toBe(false);
  });
});

describe("switchToSessionWorkspaceIfNeeded", () => {
  beforeEach(() => {
    resolveSessionWorkspaceForViewer.mockReset();
    workspaceStoreState.workspacePath = null;
    workspaceStoreState.setWorkspace.mockClear();
  });

  it("does not switch for observer sessions (null path)", async () => {
    resolveSessionWorkspaceForViewer.mockResolvedValue(null);
    await switchToSessionWorkspaceIfNeeded("teamA", "s1");
    expect(workspaceStoreState.setWorkspace).not.toHaveBeenCalled();
  });

  it("switches workspace when viewer path differs from current", async () => {
    workspaceStoreState.workspacePath = "/Users/me/copilot-ws-v2";
    resolveSessionWorkspaceForViewer.mockResolvedValue("/Users/me/copilot-ws-v3");
    await switchToSessionWorkspaceIfNeeded("teamA", "s1");
    expect(workspaceStoreState.setWorkspace).toHaveBeenCalledWith("/Users/me/copilot-ws-v3");
  });
});
