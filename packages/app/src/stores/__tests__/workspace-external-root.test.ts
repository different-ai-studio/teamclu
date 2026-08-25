import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();

vi.mock("@/lib/utils", () => ({
  isTauri: () => true,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import { useWorkspaceStore } from "../workspace";

/**
 * The team's real knowledge directory, as the daemon and the OSS sync engine
 * address it. The Knowledge column browses THIS path — never the per-workspace
 * `team-knowledge` symlink — so it is outside any workspace by construction.
 */
const KNOWLEDGE = "/Users/x/.amuxd/teams/team-1/shared/knowledge";

const dir = (parent: string, name: string) => ({
  name,
  path: `${parent}/${name}`,
  type: "directory" as const,
});
const file = (parent: string, name: string) => ({
  name,
  path: `${parent}/${name}`,
  type: "file" as const,
});

const findNode = (nodes: Array<{ path: string; children?: unknown }>, target: string): any => {
  for (const node of nodes as any[]) {
    if (node.path === target) return node;
    if (node.children) {
      const hit = findNode(node.children, target);
      if (hit) return hit;
    }
  }
  return null;
};

describe("workspace external roots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState({
      workspacePath: null,
      fileTree: [],
      externalTrees: {},
      expandedPaths: new Set<string>(),
      loadingPaths: new Set<string>(),
      selectedFile: null,
      fileContent: null,
    });
    mockInvoke.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "read_workspace_directory") {
        if (args.path === KNOWLEDGE) return [dir(KNOWLEDGE, "guides"), file(KNOWLEDGE, "top.md")];
        if (args.path === `${KNOWLEDGE}/guides`) return [file(`${KNOWLEDGE}/guides`, "setup.md")];
        if (args.path === "/workspace") return [dir("/workspace", "src")];
        return [];
      }
      if (cmd === "read_workspace_text_file") return "# hello";
      return null;
    });
  });

  /**
   * Knowledge is per-team, not per-workspace. Reading it used to require a
   * workspace to be open only because the tree was rendered through that
   * workspace's symlink — with the real path there is nothing left to wait for.
   */
  it("lists an external root with no workspace open, reading against the root itself", async () => {
    await useWorkspaceStore.getState().openExternalRoot(KNOWLEDGE);

    expect(mockInvoke).toHaveBeenCalledWith("read_workspace_directory", {
      workspacePath: KNOWLEDGE,
      path: KNOWLEDGE,
    });
    expect(useWorkspaceStore.getState().externalTrees[KNOWLEDGE].map((n) => n.name)).toEqual([
      "guides",
      "top.md",
    ]);
    // And it stays out of the workspace tree, which is what the right-hand file
    // panel renders — a foreign root parked there would show up as a stray
    // top-level folder.
    expect(useWorkspaceStore.getState().fileTree).toEqual([]);
  });

  it("expands a subdirectory inside the external tree", async () => {
    await useWorkspaceStore.getState().openExternalRoot(KNOWLEDGE);
    await useWorkspaceStore.getState().expandDirectory(`${KNOWLEDGE}/guides`);

    const guides = findNode(useWorkspaceStore.getState().externalTrees[KNOWLEDGE], `${KNOWLEDGE}/guides`);
    expect(guides.children.map((n: { name: string }) => n.name)).toEqual(["setup.md"]);
  });

  it("reads an external file against its own root", async () => {
    await useWorkspaceStore.getState().openExternalRoot(KNOWLEDGE);
    useWorkspaceStore.setState({ workspacePath: "/workspace" });

    await useWorkspaceStore.getState().selectFile(`${KNOWLEDGE}/top.md`);

    expect(mockInvoke).toHaveBeenCalledWith("read_workspace_text_file", {
      workspacePath: KNOWLEDGE,
      path: `${KNOWLEDGE}/top.md`,
    });
    expect(useWorkspaceStore.getState().fileContent).toBe("# hello");
  });

  /**
   * The daemon writes a teammate's synced note straight into its own directory.
   * A recursive watch on the workspace never saw those writes — `notify` does
   * not follow the `team-knowledge` symlink — so the real directory has to be
   * watched in its own right.
   */
  it("watches the external root, and does not re-subscribe when it is re-listed", async () => {
    await useWorkspaceStore.getState().openExternalRoot(KNOWLEDGE);
    expect(mockInvoke).toHaveBeenCalledWith("watch_directory", { path: KNOWLEDGE });

    mockInvoke.mockClear();
    await useWorkspaceStore.getState().openExternalRoot(KNOWLEDGE);
    expect(mockInvoke).not.toHaveBeenCalledWith("watch_directory", { path: KNOWLEDGE });
  });

  it("re-lists on refresh and drops expansions that vanished from disk", async () => {
    await useWorkspaceStore.getState().openExternalRoot(KNOWLEDGE);
    await useWorkspaceStore.getState().expandDirectory(`${KNOWLEDGE}/guides`);
    useWorkspaceStore.setState({
      workspacePath: "/workspace",
      expandedPaths: new Set([...useWorkspaceStore.getState().expandedPaths, "/workspace/src"]),
    });

    // A teammate deleted `guides/` on their machine and sync applied it here.
    mockInvoke.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "read_workspace_directory") {
        return args.path === KNOWLEDGE ? [file(KNOWLEDGE, "top.md")] : [];
      }
      return null;
    });
    await useWorkspaceStore.getState().refreshExternalRoot(KNOWLEDGE);

    expect(useWorkspaceStore.getState().externalTrees[KNOWLEDGE].map((n) => n.name)).toEqual([
      "top.md",
    ]);
    const expanded = useWorkspaceStore.getState().expandedPaths;
    expect(expanded.has(`${KNOWLEDGE}/guides`)).toBe(false);
    expect(expanded.has(KNOWLEDGE)).toBe(true);
    // The workspace's own expansions are none of this refresh's business.
    expect(expanded.has("/workspace/src")).toBe(true);
  });

  /**
   * Switching teams repoints knowledge at another directory. The old one must
   * stop being rendered and stop reporting, or the previous team's writes keep
   * waking the column.
   */
  it("forgets the tree, its expansions and the watch when the root is closed", async () => {
    await useWorkspaceStore.getState().openExternalRoot(KNOWLEDGE);
    await useWorkspaceStore.getState().expandDirectory(`${KNOWLEDGE}/guides`);
    useWorkspaceStore.setState({
      expandedPaths: new Set([...useWorkspaceStore.getState().expandedPaths, "/workspace/src"]),
    });

    await useWorkspaceStore.getState().closeExternalRoot(KNOWLEDGE);

    expect(mockInvoke).toHaveBeenCalledWith("unwatch_directory", { path: KNOWLEDGE });
    expect(useWorkspaceStore.getState().externalTrees[KNOWLEDGE]).toBeUndefined();
    const expanded = [...useWorkspaceStore.getState().expandedPaths];
    expect(expanded.some((p) => p.startsWith(KNOWLEDGE))).toBe(false);
    expect(expanded).toContain("/workspace/src");
  });

  /**
   * `refreshFileTree` rebuilds the WORKSPACE tree; the external root is not in
   * its listing at all. Dropping its expansions there would collapse the
   * Knowledge tree every time a workspace file changed.
   */
  it("keeps external expansions across a workspace tree refresh", async () => {
    await useWorkspaceStore.getState().openExternalRoot(KNOWLEDGE);
    await useWorkspaceStore.getState().expandDirectory(`${KNOWLEDGE}/guides`);
    useWorkspaceStore.setState({ workspacePath: "/workspace" });

    await useWorkspaceStore.getState().refreshFileTree();

    const expanded = useWorkspaceStore.getState().expandedPaths;
    expect(expanded.has(KNOWLEDGE)).toBe(true);
    expect(expanded.has(`${KNOWLEDGE}/guides`)).toBe(true);
    expect(
      findNode(useWorkspaceStore.getState().externalTrees[KNOWLEDGE], `${KNOWLEDGE}/guides`).children,
    ).toHaveLength(1);
  });
});
