import { describe, it, expect, vi, beforeEach } from "vitest";

const { resolveSessionWorkspaceForViewer } = vi.hoisted(() => ({
  resolveSessionWorkspaceForViewer: vi.fn(),
}));

vi.mock("@/lib/session/session-viewer-workspace", () => ({
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

// `path_is_directory` is the only command this module invokes.
const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => true),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  resolveSessionWorkspacePath,
  sessionBelongsToWorkspace,
  switchToSessionWorkspaceIfNeeded,
} from "@/lib/session/session-by-workspace";

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
    invoke.mockReset();
    invoke.mockResolvedValue(true);
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
    expect(invoke).toHaveBeenCalledWith("path_is_directory", { path: "/Users/me/copilot-ws-v3" });
    expect(workspaceStoreState.setWorkspace).toHaveBeenCalledWith("/Users/me/copilot-ws-v3");
  });

  it("stays put when the session's folder is not on this machine", async () => {
    // A teammate's session carries their path. Adopting it would persist
    // another machine's folder as this client's current one (#1579).
    workspaceStoreState.workspacePath = "/Users/me/mine";
    resolveSessionWorkspaceForViewer.mockResolvedValue("/Users/someone-else/TeamClu");
    invoke.mockResolvedValue(false);

    await switchToSessionWorkspaceIfNeeded("teamA", "s1");

    expect(workspaceStoreState.setWorkspace).not.toHaveBeenCalled();
    expect(workspaceStoreState.workspacePath).toBe("/Users/me/mine");
  });

  it("stays put when the folder cannot be checked", async () => {
    // Unverifiable is treated as unavailable: adopting a path we could not
    // check is the failure this guard exists to prevent.
    workspaceStoreState.workspacePath = "/Users/me/mine";
    resolveSessionWorkspaceForViewer.mockResolvedValue("/Users/someone-else/TeamClu");
    invoke.mockRejectedValue(new Error("fs unavailable"));

    await switchToSessionWorkspaceIfNeeded("teamA", "s1");

    expect(workspaceStoreState.setWorkspace).not.toHaveBeenCalled();
  });
});
