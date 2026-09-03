import { describe, it, expect, beforeEach } from "vitest";
import { useWorkspaceStore, WORKSPACE_STORAGE_KEY } from "../workspace";
import type { FileNode } from "../workspace";
import { appShortName } from "@/lib/config/build-config";

describe("Workspace store (W-03, W-14)", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      expandedPaths: new Set<string>(),
      fileTree: [],
    });
  });

  it("W-03: uses dynamic appShortName for localStorage persistence", () => {
    expect(WORKSPACE_STORAGE_KEY).toBe(`${appShortName}-workspace-path`);
  });

  it("W-14: flattenVisibleFileTree returns visible file paths in order", () => {
    useWorkspaceStore.setState({
      expandedPaths: new Set(["/dir"]),
    });
    const tree: FileNode[] = [
      { name: "a", path: "/a", type: "file" },
      {
        name: "dir",
        path: "/dir",
        type: "directory",
        children: [
          { name: "b", path: "/dir/b", type: "file" },
        ],
      },
    ];
    const flat = useWorkspaceStore.getState().flattenVisibleFileTree(tree);
    expect(flat).toEqual(["/a", "/dir/b"]);
  });
});
