import { beforeEach, describe, expect, test, vi } from "vitest";
import { useTerminalStore, useAnyTerminalBusy } from "@/stores/terminal-store";
import { renderHook } from "@testing-library/react";

vi.mock("@/lib/terminal/client", () => ({
  openTerminal: vi.fn(async () => ({ id: "tab-1", shell: "/bin/zsh", pid: 100 })),
  closeTerminal: vi.fn(async () => {}),
  listTerminals: vi.fn(async () => []),
}));

const seedTab = (id: string, workspaceId: string) => ({
  id,
  workspaceId,
  title: "zsh",
  pid: 100,
  shell: "/bin/zsh",
  cwd: "/tmp",
  status: "running" as const,
});

describe("terminal-store", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      tabsByWorkspace: {},
      activeTabByWorkspace: {},
      panelOpenByWorkspace: {},
      panelHeightByWorkspace: {},
    });
  });

  test("openTerminal appends a tab and sets it active", async () => {
    await useTerminalStore.getState().openTerminal("ws1", {
      cwd: "/tmp",
      allowedRoots: ["/tmp"],
    });
    const s = useTerminalStore.getState();
    expect(s.tabsByWorkspace["ws1"]?.length).toBe(1);
    expect(s.activeTabByWorkspace["ws1"]).toBe("tab-1");
  });

  test("togglePanel flips open/closed", () => {
    useTerminalStore.getState().togglePanel("ws1");
    expect(useTerminalStore.getState().panelOpenByWorkspace["ws1"]).toBe(true);
    useTerminalStore.getState().togglePanel("ws1");
    expect(useTerminalStore.getState().panelOpenByWorkspace["ws1"]).toBe(false);
  });

  test("renameTab updates title", () => {
    useTerminalStore.setState({
      tabsByWorkspace: { ws1: [seedTab("a", "ws1")] },
    });
    useTerminalStore.getState().renameTab("a", "build");
    expect(useTerminalStore.getState().tabsByWorkspace["ws1"][0].title).toBe("build");
  });

  test("closeTerminal removes tab and clears active when no remain", async () => {
    useTerminalStore.setState({
      tabsByWorkspace: { ws1: [seedTab("a", "ws1")] },
      activeTabByWorkspace: { ws1: "a" },
    });
    await useTerminalStore.getState().closeTerminal("a");
    const s = useTerminalStore.getState();
    expect(s.tabsByWorkspace["ws1"]).toEqual([]);
    expect(s.activeTabByWorkspace["ws1"]).toBeNull();
  });

  test("closeTerminal picks neighbor when closing active", async () => {
    useTerminalStore.setState({
      tabsByWorkspace: { ws1: [seedTab("a", "ws1"), seedTab("b", "ws1"), seedTab("c", "ws1")] },
      activeTabByWorkspace: { ws1: "b" },
    });
    await useTerminalStore.getState().closeTerminal("b");
    expect(useTerminalStore.getState().activeTabByWorkspace["ws1"]).toBe("a");
  });

  test("markExited updates status, keeps tab present", () => {
    useTerminalStore.setState({
      tabsByWorkspace: { ws1: [seedTab("a", "ws1")] },
    });
    useTerminalStore.getState().markExited("a", 0);
    const tab = useTerminalStore.getState().tabsByWorkspace["ws1"][0];
    expect(tab.status).toBe("exited");
    expect(tab.exitCode).toBe(0);
  });

  test("recordCommandStart marks the tab busy", () => {
    useTerminalStore.setState({
      tabsByWorkspace: { ws1: [seedTab("a", "ws1")] },
    });
    useTerminalStore.getState().recordCommandStart("a", "npm run build");
    const tab = useTerminalStore.getState().tabsByWorkspace["ws1"][0];
    expect(tab.busy).toBe(true);
    expect(tab.lastCommand).toBe("npm run build");
  });

  test("recordCommandFinish clears busy even when the exit code fails to parse", () => {
    useTerminalStore.setState({
      tabsByWorkspace: { ws1: [seedTab("a", "ws1")] },
    });
    useTerminalStore.getState().recordCommandStart("a", "npm run build");
    // `null` is what osc633.ts passes when the D marker's exit code did not
    // parse — busy must still clear, since that is what distinguishes it from
    // "still running".
    useTerminalStore.getState().recordCommandFinish("a", null);
    const tab = useTerminalStore.getState().tabsByWorkspace["ws1"][0];
    expect(tab.busy).toBe(false);
    expect(tab.lastCommandExit).toBeUndefined();
  });

  test("useAnyTerminalBusy is true only while some tab is busy, across workspaces", () => {
    useTerminalStore.setState({
      tabsByWorkspace: { ws1: [seedTab("a", "ws1")], ws2: [seedTab("b", "ws2")] },
    });
    const { result } = renderHook(() => useAnyTerminalBusy());
    expect(result.current).toBe(false);

    useTerminalStore.getState().recordCommandStart("b", "tail -f log");
    expect(renderHook(() => useAnyTerminalBusy()).result.current).toBe(true);

    useTerminalStore.getState().recordCommandFinish("b", 0);
    expect(renderHook(() => useAnyTerminalBusy()).result.current).toBe(false);
  });
});
