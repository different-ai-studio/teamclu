import { describe, it, expect, beforeEach } from "vitest";
import { useWorkspaceStore } from "../workspace";
import type { FileNode } from "../workspace";
import { workspacePathsMatch } from "../session-utils";

describe("flattenVisibleFileTree (REG-05, W-14)", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      expandedPaths: new Set<string>(),
      fileTree: [],
    });
  });

  it("returns file paths in tree order when nothing expanded", () => {
    const tree: FileNode[] = [
      { name: "a", path: "/a", type: "file" },
      { name: "b", path: "/b", type: "file" },
    ];
    const flat = useWorkspaceStore.getState().flattenVisibleFileTree(tree);
    expect(flat).toEqual(["/a", "/b"]);
  });

  it("includes children of expanded directories in order", () => {
    useWorkspaceStore.setState({
      expandedPaths: new Set(["/dir"]),
    });
    const tree: FileNode[] = [
      {
        name: "dir",
        path: "/dir",
        type: "directory",
        children: [
          { name: "c", path: "/dir/c", type: "file" },
          { name: "d", path: "/dir/d", type: "file" },
        ],
      },
    ];
    const flat = useWorkspaceStore.getState().flattenVisibleFileTree(tree);
    expect(flat).toEqual(["/dir/c", "/dir/d"]);
  });

  it("skips children of collapsed directories", () => {
    useWorkspaceStore.setState({ expandedPaths: new Set() });
    const tree: FileNode[] = [
      {
        name: "dir",
        path: "/dir",
        type: "directory",
        children: [
          { name: "c", path: "/dir/c", type: "file" },
        ],
      },
    ];
    const flat = useWorkspaceStore.getState().flattenVisibleFileTree(tree);
    expect(flat).toEqual([]);
  });
});

describe("workspacePathsMatch (REG-12, S-15)", () => {
  it("returns true for identical paths", () => {
    expect(workspacePathsMatch("/foo", "/foo")).toBe(true);
    expect(workspacePathsMatch("/foo/", "/foo")).toBe(true);
  });

  it("treats ~/x and /absolute/path/to/x as same workspace", () => {
    expect(workspacePathsMatch("~/projects/x", "/Users/me/projects/x")).toBe(
      true
    );
    expect(workspacePathsMatch("/home/user/x", "~/x")).toBe(true);
  });

  it("returns false when last path component differs", () => {
    expect(workspacePathsMatch("~/a", "/tmp/b")).toBe(false);
  });

  it("requires full tilde-relative suffix, not just the leaf directory name", () => {
    expect(workspacePathsMatch("~/projects/x", "/Users/me/other/x")).toBe(false);
    expect(workspacePathsMatch("~/TeamClu", "/Users/matt.chow/TeamClu")).toBe(true);
  });
});
