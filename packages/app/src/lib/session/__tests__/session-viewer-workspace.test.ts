import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ViewerWorkspaceContext } from "@/lib/session/session-viewer-workspace";

const { getSessionParticipants } = vi.hoisted(() => ({
  getSessionParticipants: vi.fn(),
}));
const { loadSessionWorkspacesForTeam } = vi.hoisted(() => ({
  loadSessionWorkspacesForTeam: vi.fn(),
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({ sessions: { getSessionParticipants } }),
}));
vi.mock("@/lib/cache/local-cache", () => ({ loadSessionWorkspacesForTeam }));

import {
  bindingsFromCacheRows,
  isViewerAgent,
  pickBestViewerSessionPath,
  pickSessionWorkspaceLabel,
  resolveLocalPathForCloudWorkspace,
  resolveSessionWorkspaceForViewer,
} from "@/lib/session/session-viewer-workspace";

function makeCtx(overrides: Partial<ViewerWorkspaceContext> = {}): ViewerWorkspaceContext {
  return {
    memberId: "member-b",
    localDaemonAgentId: "agent-local",
    ownedAgentIds: new Set(["agent-local"]),
    localWorkspacesByCloudId: new Map([
      ["ws-b", { path: "/Users/b/my-proj", agentId: "agent-local" }],
    ]),
    ...overrides,
  };
}

describe("resolveSessionWorkspaceForViewer", () => {
  beforeEach(() => {
    getSessionParticipants.mockReset();
    loadSessionWorkspacesForTeam.mockReset();
  });

  it("returns null for observer sessions (no owned-agent runtime)", async () => {
    // The workspace rides the participant row now (ADR-0005) — one call for
    // this session instead of the team's whole runtime list.
    getSessionParticipants.mockResolvedValue([
      { session_id: "s1", actor_id: "agent-alice", workspaceId: "ws-a" },
    ]);
    loadSessionWorkspacesForTeam.mockResolvedValue([]);
    await expect(
      resolveSessionWorkspaceForViewer("teamA", "s1", makeCtx()),
    ).resolves.toBeNull();
  });

  it("falls back to viewer cache when the session has no bound workspace", async () => {
    getSessionParticipants.mockResolvedValue([]);
    loadSessionWorkspacesForTeam.mockResolvedValue([
      {
        sessionId: "s1",
        teamId: "teamA",
        viewerMemberId: "member-b",
        agentId: "agent-local",
        workspaceId: "ws-b",
        workspacePath: "/Users/b/my-proj",
        updatedAt: "2026-06-01T00:00:00Z",
      },
    ]);
    await expect(
      resolveSessionWorkspaceForViewer("teamA", "s1", makeCtx()),
    ).resolves.toBe("/Users/b/my-proj");
    expect(loadSessionWorkspacesForTeam).toHaveBeenCalledWith("teamA", "member-b");
  });

  it("prefers local daemon agent binding over other owned agents", async () => {
    getSessionParticipants.mockResolvedValue([
      { session_id: "s1", actor_id: "agent-other-owned", workspaceId: "ws-other" },
      { session_id: "s1", actor_id: "agent-local", workspaceId: "ws-b" },
    ]);
    const ctx = makeCtx({
      ownedAgentIds: new Set(["agent-local", "agent-other-owned"]),
      localWorkspacesByCloudId: new Map([
        ["ws-b", { path: "/Users/b/my-proj", agentId: "agent-local" }],
        ["ws-other", { path: "/Users/b/other-proj", agentId: "agent-other-owned" }],
      ]),
    });
    await expect(
      resolveSessionWorkspaceForViewer("teamA", "s1", ctx),
    ).resolves.toBe("/Users/b/my-proj");
  });
});

describe("pickBestViewerSessionPath", () => {
  it("uses newest accessible binding when daemon agent has none", () => {
    const path = pickBestViewerSessionPath(
      [
        {
          agentId: "agent-owned",
          cloudWorkspaceId: "ws-old",
          localPath: "/Users/b/old",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        {
          agentId: "agent-owned",
          cloudWorkspaceId: "ws-new",
          localPath: "/Users/b/new",
          updatedAt: "2026-06-01T00:00:00Z",
        },
      ],
      makeCtx({ localDaemonAgentId: null, ownedAgentIds: new Set(["agent-owned"]) }),
    );
    expect(path).toBe("/Users/b/new");
  });
});

describe("pickSessionWorkspaceLabel", () => {
  it("returns basename when a local path is adoptable", () => {
    const label = pickSessionWorkspaceLabel(
      [
        {
          sessionId: "s1",
          teamId: "teamA",
          viewerMemberId: "member-b",
          agentId: "agent-local",
          workspaceId: "ws-b",
          workspacePath: "/Users/b/my-proj",
          updatedAt: "2026-06-01T00:00:00Z",
        },
      ],
      "s1",
      makeCtx(),
    );
    expect(label).toBe("my-proj");
  });
});

describe("bindingsFromCacheRows", () => {
  it("rehydrates local paths from daemon registry when cache path is missing", () => {
    const bindings = bindingsFromCacheRows(
      [
        {
          sessionId: "s1",
          teamId: "teamA",
          viewerMemberId: "member-b",
          agentId: "agent-local",
          workspaceId: "ws-b",
          workspacePath: null,
          updatedAt: "2026-06-01T00:00:00Z",
        },
      ],
      makeCtx(),
      "s1",
    );
    expect(bindings[0].localPath).toBe("/Users/b/my-proj");
  });
});

describe("resolveLocalPathForCloudWorkspace", () => {
  it("returns null for unknown cloud ids", () => {
    expect(resolveLocalPathForCloudWorkspace("missing", makeCtx())).toBeNull();
  });
});

describe("isViewerAgent", () => {
  it("matches owned agent ids only", () => {
    const ctx = makeCtx({ ownedAgentIds: new Set(["agent-local"]) });
    expect(isViewerAgent("agent-local", ctx)).toBe(true);
    expect(isViewerAgent("agent-alice", ctx)).toBe(false);
  });
});
