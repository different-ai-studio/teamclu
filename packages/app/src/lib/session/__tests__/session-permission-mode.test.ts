import { beforeEach, describe, expect, it, vi } from "vitest";

const mockStore: Record<string, string> = {};
const mockLocalStorage = {
  getItem: vi.fn((key: string) => mockStore[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    mockStore[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete mockStore[key];
  }),
  clear: vi.fn(() => {
    Object.keys(mockStore).forEach((k) => delete mockStore[k]);
  }),
  length: 0,
  key: vi.fn(() => null),
};

Object.defineProperty(globalThis, "localStorage", {
  value: mockLocalStorage,
  writable: true,
});

const listRows: { id: string; source?: string | null }[] = [];

vi.mock("@/stores/session-list-store", () => ({
  useSessionListStore: Object.assign(
    (selector: (s: { rows: typeof listRows }) => unknown) =>
      selector({ rows: listRows }),
    {
      getState: () => ({ rows: listRows }),
    },
  ),
}));

import {
  getSessionPermissionMode,
  isUnattendedSessionSource,
  resetSessionPermissionModesForTests,
  setSessionPermissionMode,
  shouldAutoAllowSessionPermissions,
  subscribeSessionPermissionModes,
} from "@/lib/session/session-permission-mode";

describe("session-permission-mode", () => {
  beforeEach(() => {
    mockLocalStorage.clear();
    vi.clearAllMocks();
    listRows.length = 0;
    resetSessionPermissionModesForTests();
  });

  it("defaults to default for unknown session", () => {
    expect(getSessionPermissionMode("sess-1")).toBe("default");
    expect(shouldAutoAllowSessionPermissions("sess-1")).toBe(false);
  });

  it("defaults gateway and cron sessions to fullAccess", () => {
    expect(isUnattendedSessionSource("gateway")).toBe(true);
    expect(isUnattendedSessionSource("cron")).toBe(true);
    expect(isUnattendedSessionSource("user")).toBe(false);

    expect(getSessionPermissionMode("gw-1", "gateway")).toBe("fullAccess");
    expect(getSessionPermissionMode("cron-1", "cron")).toBe("fullAccess");
    expect(shouldAutoAllowSessionPermissions("gw-1")).toBe(false);

    listRows.push({ id: "gw-1", source: "gateway" });
    expect(getSessionPermissionMode("gw-1")).toBe("fullAccess");
    expect(shouldAutoAllowSessionPermissions("gw-1")).toBe(true);
  });

  it("persists fullAccess per session", () => {
    setSessionPermissionMode("sess-a", "fullAccess");
    setSessionPermissionMode("sess-b", "default");

    expect(getSessionPermissionMode("sess-a")).toBe("fullAccess");
    expect(getSessionPermissionMode("sess-b")).toBe("default");
    expect(shouldAutoAllowSessionPermissions("sess-a")).toBe(true);
  });

  it("removes key when set back to default", () => {
    setSessionPermissionMode("sess-a", "fullAccess");
    setSessionPermissionMode("sess-a", "default");
    expect(getSessionPermissionMode("sess-a")).toBe("default");
    expect(mockLocalStorage.setItem).toHaveBeenCalled();
    const last = mockLocalStorage.setItem.mock.calls.at(-1)?.[1] as string;
    expect(last).not.toContain("sess-a");
  });

  it("keeps explicit default on a gateway session", () => {
    listRows.push({ id: "gw-1", source: "gateway" });
    expect(getSessionPermissionMode("gw-1")).toBe("fullAccess");

    setSessionPermissionMode("gw-1", "default");
    expect(getSessionPermissionMode("gw-1")).toBe("default");
    expect(shouldAutoAllowSessionPermissions("gw-1")).toBe(false);

    setSessionPermissionMode("gw-1", "fullAccess");
    expect(getSessionPermissionMode("gw-1")).toBe("fullAccess");
  });

  it("LRU evicts oldest when exceeding 200 fullAccess sessions", () => {
    for (let i = 0; i < 201; i++) {
      setSessionPermissionMode(`sess-${i}`, "fullAccess");
    }
    expect(getSessionPermissionMode("sess-0")).toBe("default");
    expect(getSessionPermissionMode("sess-200")).toBe("fullAccess");
  });

  it("notifies subscribers on change", () => {
    const cb = vi.fn();
    const unsub = subscribeSessionPermissionModes(cb);
    setSessionPermissionMode("sess-1", "fullAccess");
    expect(cb).toHaveBeenCalled();
    unsub();
  });
});
