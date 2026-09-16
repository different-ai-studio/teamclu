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

import { appStoragePrefix } from "@/lib/config/build-config";
import {
  getSessionDefaultPermissionMode,
  getSessionPermissionMode,
  hasExplicitSessionPermissionMode,
  isUnattendedSessionSource,
  resetSessionPermissionModesForTests,
  setSessionDefaultPermissionMode,
  setSessionPermissionMode,
  subscribeSessionPermissionModes,
} from "@/lib/session/session-permission-mode";

const DEFAULT_MODE_STORAGE_KEY = `${appStoragePrefix}-default-session-permission-mode`;

describe("session-permission-mode", () => {
  beforeEach(() => {
    mockLocalStorage.clear();
    vi.clearAllMocks();
    listRows.length = 0;
    resetSessionPermissionModesForTests();
  });

  it("defaults to default for unknown session", () => {
    expect(getSessionPermissionMode("sess-1")).toBe("default");
  });

  it("defaults gateway and cron sessions to fullAccess", () => {
    expect(isUnattendedSessionSource("gateway")).toBe(true);
    expect(isUnattendedSessionSource("cron")).toBe(true);
    expect(isUnattendedSessionSource("user")).toBe(false);

    expect(getSessionPermissionMode("gw-1", "gateway")).toBe("fullAccess");
    expect(getSessionPermissionMode("cron-1", "cron")).toBe("fullAccess");

    listRows.push({ id: "gw-1", source: "gateway" });
    expect(getSessionPermissionMode("gw-1")).toBe("fullAccess");
  });

  it("persists fullAccess per session", () => {
    setSessionPermissionMode("sess-a", "fullAccess");
    setSessionPermissionMode("sess-b", "default");

    expect(getSessionPermissionMode("sess-a")).toBe("fullAccess");
    expect(getSessionPermissionMode("sess-b")).toBe("default");
  });

  it("records an explicit ask when set back to default", () => {
    setSessionPermissionMode("sess-a", "fullAccess");
    setSessionPermissionMode("sess-a", "default");
    expect(getSessionPermissionMode("sess-a")).toBe("default");
    expect(hasExplicitSessionPermissionMode("sess-a")).toBe(true);
    expect(mockLocalStorage.setItem).toHaveBeenCalled();
    const last = mockLocalStorage.setItem.mock.calls.at(-1)?.[1] as string;
    // The ask choice must persist (forceDefault), otherwise a global default
    // of fullAccess would swallow it.
    expect(last).toContain("sess-a");
  });

  it("resolves unknown sessions through the configurable global default", () => {
    expect(getSessionDefaultPermissionMode()).toBe("default");
    expect(getSessionPermissionMode("sess-1")).toBe("default");

    setSessionDefaultPermissionMode("fullAccess");
    expect(getSessionDefaultPermissionMode()).toBe("fullAccess");
    expect(getSessionPermissionMode("sess-1")).toBe("fullAccess");
    expect(hasExplicitSessionPermissionMode("sess-1")).toBe(false);

    setSessionDefaultPermissionMode("default");
    expect(getSessionPermissionMode("sess-1")).toBe("default");
  });

  it("explicit per-session choices override the global default", () => {
    setSessionDefaultPermissionMode("fullAccess");
    setSessionPermissionMode("sess-ask", "default");
    expect(getSessionPermissionMode("sess-ask")).toBe("default");

    setSessionDefaultPermissionMode("default");
    setSessionPermissionMode("sess-full", "fullAccess");
    expect(getSessionPermissionMode("sess-full")).toBe("fullAccess");
  });

  it("unattended sessions stay fullAccess regardless of the global default", () => {
    setSessionDefaultPermissionMode("default");
    expect(getSessionPermissionMode("gw-1", "gateway")).toBe("fullAccess");
    expect(getSessionPermissionMode("cron-1", "cron")).toBe("fullAccess");
  });

  it("ignores unknown global default values", () => {
    mockStore[DEFAULT_MODE_STORAGE_KEY] = "nonsense";
    expect(getSessionDefaultPermissionMode()).toBe("default");
  });

  it("notifies subscribers when the global default changes", () => {
    const cb = vi.fn();
    const unsub = subscribeSessionPermissionModes(cb);
    setSessionDefaultPermissionMode("fullAccess");
    expect(cb).toHaveBeenCalled();
    unsub();
  });

  it("keeps explicit default on a gateway session", () => {
    listRows.push({ id: "gw-1", source: "gateway" });
    expect(getSessionPermissionMode("gw-1")).toBe("fullAccess");

    setSessionPermissionMode("gw-1", "default");
    expect(getSessionPermissionMode("gw-1")).toBe("default");

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
