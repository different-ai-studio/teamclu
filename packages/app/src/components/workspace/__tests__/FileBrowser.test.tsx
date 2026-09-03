// @vitest-environment jsdom

import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MockFileNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: MockFileNode[];
};

let mockFileTree: MockFileNode[] = [];
let latestNodesProp: MockFileNode[] | undefined;

const mockExpandDirectory = vi.fn(async (path: string) => {
  if (path === "/workspace/teamclu-team") {
    mockFileTree = mockFileTree.map((node) =>
      node.path === path
        ? {
            ...node,
            children: [
              {
                name: "knowledge",
                path: "/workspace/teamclu-team/knowledge",
                type: "directory",
              },
            ],
          }
        : node,
    );
  }

  if (path === "/workspace/teamclu-team/knowledge") {
    mockFileTree = mockFileTree.map((node) =>
      node.path === "/workspace/teamclu-team"
        ? {
            ...node,
            children: node.children?.map((child) =>
              child.path === path
                ? {
                    ...child,
                    children: [
                      {
                        name: "guide.md",
                        path: "/workspace/teamclu-team/knowledge/guide.md",
                        type: "file",
                      },
                    ],
                  }
                : child,
            ),
          }
        : node,
    );
  }
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: Array<string | false | null | undefined>) =>
    args.filter(Boolean).join(" "),
  isTauri: () => false,
}));

vi.mock("@/hooks/use-file-change-listener", () => ({
  useFileChangeListener: vi.fn(),
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollBar: () => null,
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} />
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("../FileTree", () => ({
  FileTree: ({ nodes }: { nodes?: MockFileNode[] }) => {
    latestNodesProp = nodes;
    return <div data-testid="file-tree" />;
  },
}));

const ossSyncState = vi.hoisted(() => ({
  teamId: "team-1" as string | null,
  syncing: false,
  refresh: vi.fn().mockResolvedValue(undefined),
  syncNow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/stores/oss-sync", () => ({
  useOssSyncStore: (selector: (state: typeof ossSyncState) => unknown) =>
    selector(ossSyncState),
}));

vi.mock("@/stores/workspace", () => ({
  useWorkspaceStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        workspacePath: "/workspace",
        isPanelOpen: true,
        fileTree: mockFileTree,
        refreshFileTree: vi.fn().mockResolvedValue(undefined),
        collapseAll: vi.fn(),
        undo: vi.fn().mockResolvedValue(true),
        undoStack: [],
        expandDirectory: mockExpandDirectory,
      }),
    {
      getState: () => ({
        workspacePath: "/workspace",
        // Mirrors the selector view above: FileBrowser reads the tree back out
        // of getState between awaits, since the closed-over value goes stale.
        get fileTree() {
          return mockFileTree;
        },
        expandDirectory: mockExpandDirectory,
      }),
      subscribe: vi.fn(() => vi.fn()),
      setState: vi.fn(),
    },
  ),
}));

import { FileBrowser } from "../FileBrowser";

describe("FileBrowser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFileTree = [];
    latestNodesProp = undefined;
    ossSyncState.teamId = "team-1";
  });

  it("hides built-in OSS sync when the caller already supplies actionIcons", () => {
    render(
      <FileBrowser
        variant="panel"
        actionIcons={<button data-testid="caller-sync">Sync</button>}
      />,
    );

    expect(screen.getByTestId("caller-sync")).toBeTruthy();
    expect(screen.queryByTestId("filebrowser-oss-sync")).toBeNull();
  });

  it("shows built-in OSS sync for workspace root when no actionIcons are provided", () => {
    render(<FileBrowser variant="panel" />);

    expect(screen.getByTestId("filebrowser-oss-sync")).toBeTruthy();
  });

  it("retries loading custom root ancestors after the global tree becomes available", async () => {
    const rootPath = "/workspace/teamclu-team/knowledge";
    const rootPaths = [rootPath];
    const { rerender } = render(
      <FileBrowser variant="panel" rootPaths={rootPaths} />,
    );

    await waitFor(() => {
      expect(mockExpandDirectory).toHaveBeenCalledWith("/workspace/teamclu-team");
      expect(mockExpandDirectory).toHaveBeenCalledWith(rootPath);
    });

    await act(async () => {
      mockFileTree = [
        {
          name: "teamclu-team",
          path: "/workspace/teamclu-team",
          type: "directory",
        },
      ];
      rerender(<FileBrowser variant="panel" rootPaths={rootPaths} />);
    });

    await waitFor(() => {
      expect(mockExpandDirectory).toHaveBeenCalledTimes(4);
    });

    await act(async () => {
      rerender(<FileBrowser variant="panel" rootPaths={rootPaths} />);
    });

    expect(latestNodesProp?.[0]?.children).toEqual([
      {
        name: "guide.md",
        path: "/workspace/teamclu-team/knowledge/guide.md",
        type: "file",
      },
    ]);
  });
});
