import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const markSessionViewed = vi.hoisted(() => vi.fn(async () => {}));
const patchRow = vi.hoisted(() => vi.fn());

vi.mock("@/stores/session-list-store", () => ({
  useSessionListStore: {
    getState: () => ({
      markSessionViewed,
      patchRow,
    }),
  },
}));

const selectionState = vi.hoisted(() => ({
  activeSessionId: null as string | null,
  viewingArchivedSessionId: null as string | null,
}));

vi.mock("@/stores/session-selection-store", () => ({
  useSessionSelectionStore: {
    getState: () => selectionState,
  },
}));

import {
  isSessionActivelyViewed,
  resetActiveSessionReadForTests,
  scheduleMarkActiveSessionRead,
  shouldMarkSessionUnread,
} from "@/lib/active-session-read";

const MARK_ACTIVE_SESSION_READ_MS = 300;

describe("active-session-read", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetActiveSessionReadForTests();
    markSessionViewed.mockClear();
    patchRow.mockClear();
    selectionState.activeSessionId = null;
    selectionState.viewingArchivedSessionId = null;
  });

  afterEach(() => {
    resetActiveSessionReadForTests();
    vi.useRealTimers();
  });

  it("isSessionActivelyViewed is false when session is not active", () => {
    selectionState.activeSessionId = "other";
    expect(isSessionActivelyViewed("s1")).toBe(false);
    expect(shouldMarkSessionUnread("s1")).toBe(true);
  });

  it("isSessionActivelyViewed is false when viewing archived overlay", () => {
    selectionState.activeSessionId = "s1";
    selectionState.viewingArchivedSessionId = "s1";
    expect(isSessionActivelyViewed("s1")).toBe(false);
  });

  it("scheduleMarkActiveSessionRead clears unread locally and debounces mark-viewed", () => {
    selectionState.activeSessionId = "s1";
    scheduleMarkActiveSessionRead("s1", "msg-1");
    expect(patchRow).toHaveBeenCalledWith("s1", { has_unread: false });
    expect(markSessionViewed).not.toHaveBeenCalled();

    vi.advanceTimersByTime(MARK_ACTIVE_SESSION_READ_MS);
    expect(markSessionViewed).toHaveBeenCalledWith("s1", "msg-1");
  });

  it("coalesces burst mark-read into one API call with latest message id", () => {
    selectionState.activeSessionId = "s1";
    scheduleMarkActiveSessionRead("s1", "msg-1");
    vi.advanceTimersByTime(100);
    scheduleMarkActiveSessionRead("s1", "msg-2");

    vi.advanceTimersByTime(MARK_ACTIVE_SESSION_READ_MS);
    expect(markSessionViewed).toHaveBeenCalledOnce();
    expect(markSessionViewed).toHaveBeenCalledWith("s1", "msg-2");
  });

  it("still marks read after debounce when user switched away mid-window", () => {
    selectionState.activeSessionId = "s1";
    scheduleMarkActiveSessionRead("s1", "msg-1");
    selectionState.activeSessionId = "s2";
    vi.advanceTimersByTime(MARK_ACTIVE_SESSION_READ_MS);
    expect(markSessionViewed).toHaveBeenCalledWith("s1", "msg-1");
  });

  it("no-ops when session is not actively viewed", () => {
    scheduleMarkActiveSessionRead("s1", "msg-1");
    expect(patchRow).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MARK_ACTIVE_SESSION_READ_MS);
    expect(markSessionViewed).not.toHaveBeenCalled();
  });
});
