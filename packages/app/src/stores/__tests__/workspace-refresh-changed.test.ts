import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();

vi.mock("@/lib/utils", () => ({
  isTauri: () => true,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import { useWorkspaceStore, type FileNode } from "../workspace";

const WS = "/workspace";
const KNOWLEDGE = "/Users/x/.amuxd/teams/team-1/shared/knowledge";

const dir = (parent: string, name: string, children?: FileNode[]): FileNode => ({
  name,
  path: `${parent}/${name}`,
  type: "directory",
  ...(children !== undefined ? { children } : {}),
});
const file = (parent: string, name: string): FileNode => ({
  name,
  path: `${parent}/${name}`,
  type: "file",
});

/** What `read_workspace_directory` answers per path, mutable per test. */
let listings: Record<string, FileNode[]> = {};
const listedPaths = () =>
  mockInvoke.mock.calls
    .filter(([cmd]) => cmd === "read_workspace_directory")
    .map(([, args]) => (args as { path: string }).path);

describe("workspace refreshChangedDirectories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listings = {
      [WS]: [dir(WS, "src"), dir(WS, "docs"), file(WS, "README.md")],
      [`${WS}/src`]: [file(`${WS}/src`, "a.ts"), dir(`${WS}/src`, "lib")],
      [`${WS}/src/lib`]: [file(`${WS}/src/lib`, "x.ts")],
      [`${WS}/docs`]: [file(`${WS}/docs`, "guide.md")],
    };
    mockInvoke.mockImplementation(async (cmd: string, args: { path: string }) => {
      if (cmd === "read_workspace_directory") return listings[args.path] ?? [];
      return true;
    });
    useWorkspaceStore.setState({
      workspacePath: WS,
      externalTrees: {},
      expandedPaths: new Set<string>([`${WS}/src`, `${WS}/src/lib`]),
      loadingPaths: new Set<string>(),
      // src and src/lib expanded; docs listed but never expanded.
      fileTree: [
        dir(WS, "src", [file(`${WS}/src`, "a.ts"), dir(`${WS}/src`, "lib", [file(`${WS}/src/lib`, "x.ts")])]),
        dir(WS, "docs"),
        file(WS, "README.md"),
      ],
    });
  });

  it("re-lists only the changed directory and keeps its expanded subtree", async () => {
    listings[`${WS}/src`] = [file(`${WS}/src`, "a.ts"), file(`${WS}/src`, "b.ts"), dir(`${WS}/src`, "lib")];

    await useWorkspaceStore.getState().refreshChangedDirectories([`${WS}/src`]);

    expect(listedPaths()).toEqual([`${WS}/src`]);
    const src = useWorkspaceStore.getState().fileTree.find((n) => n.name === "src")!;
    // `loadDirectory` sorts: directories first, then by name.
    expect(src.children!.map((n) => n.name)).toEqual(["lib", "a.ts", "b.ts"]);
    // The grandchildren survive the parent's re-list.
    const lib = src.children!.find((n) => n.name === "lib")!;
    expect(lib.children?.map((n) => n.name)).toEqual(["x.ts"]);
  });

  it("skips a directory that is listed but was never expanded", async () => {
    await useWorkspaceStore.getState().refreshChangedDirectories([`${WS}/docs`]);
    expect(listedPaths()).toEqual([]);
  });

  it("skips directories outside every root it owns", async () => {
    await useWorkspaceStore.getState().refreshChangedDirectories(["/elsewhere", "/workspaceX/src"]);
    expect(listedPaths()).toEqual([]);
  });

  it("re-lists the root for a top-level change without touching open folders", async () => {
    listings[WS] = [dir(WS, "src"), dir(WS, "docs"), file(WS, "README.md"), file(WS, "NEW.md")];

    await useWorkspaceStore.getState().refreshChangedDirectories([WS]);

    expect(listedPaths()).toEqual([WS]);
    const tree = useWorkspaceStore.getState().fileTree;
    expect(tree.map((n) => n.name)).toEqual(["docs", "src", "NEW.md", "README.md"]);
    // src keeps its loaded children through the merge.
    expect(tree.find((n) => n.name === "src")!.children?.length).toBe(2);
  });

  it("drops the expansion of a directory that no longer exists", async () => {
    // src/lib was deleted: its parent lists without it, and the batch names
    // both the parent and the (now gone) directory itself.
    listings[`${WS}/src`] = [file(`${WS}/src`, "a.ts")];
    delete listings[`${WS}/src/lib`];

    await useWorkspaceStore
      .getState()
      .refreshChangedDirectories([`${WS}/src/lib`, `${WS}/src`]);

    // Parent first (shorter path), and the vanished child is never read.
    expect(listedPaths()).toEqual([`${WS}/src`]);
    expect(useWorkspaceStore.getState().expandedPaths.has(`${WS}/src/lib`)).toBe(false);
    expect(useWorkspaceStore.getState().expandedPaths.has(`${WS}/src`)).toBe(true);
  });

  it("re-lists inside an external root against that root", async () => {
    listings[KNOWLEDGE] = [dir(KNOWLEDGE, "guides"), file(KNOWLEDGE, "top.md")];
    listings[`${KNOWLEDGE}/guides`] = [file(`${KNOWLEDGE}/guides`, "setup.md"), file(`${KNOWLEDGE}/guides`, "faq.md")];
    useWorkspaceStore.setState({
      externalTrees: {
        [KNOWLEDGE]: [dir(KNOWLEDGE, "guides", [file(`${KNOWLEDGE}/guides`, "setup.md")]), file(KNOWLEDGE, "top.md")],
      },
      expandedPaths: new Set<string>([`${KNOWLEDGE}/guides`]),
    });

    await useWorkspaceStore.getState().refreshChangedDirectories([`${KNOWLEDGE}/guides`]);

    const call = mockInvoke.mock.calls.find(([cmd]) => cmd === "read_workspace_directory")!;
    expect(call[1]).toEqual({ workspacePath: KNOWLEDGE, path: `${KNOWLEDGE}/guides` });
    const guides = useWorkspaceStore.getState().externalTrees[KNOWLEDGE].find((n) => n.name === "guides")!;
    expect(guides.children!.map((n) => n.name)).toEqual(["faq.md", "setup.md"]);
    // The workspace tree is untouched.
    expect(useWorkspaceStore.getState().fileTree.find((n) => n.name === "src")!.children?.length).toBe(2);
  });

  it("does nothing for an empty batch", async () => {
    await useWorkspaceStore.getState().refreshChangedDirectories([]);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
