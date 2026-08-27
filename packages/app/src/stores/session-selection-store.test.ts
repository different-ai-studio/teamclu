import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionListStore } from "./session-list-store";
import { useSessionSelectionStore } from "./session-selection-store";

beforeEach(() => {
  useSessionSelectionStore.setState({
    activeSessionId: null,
    currentSessionId: null,
    viewingArchivedSessionId: null,
  });
  useSessionListStore.setState({
    rows: [],
    error: null,
    markSessionViewed: vi.fn().mockResolvedValue(undefined),
  } as Partial<ReturnType<typeof useSessionListStore.getState>>);
});

describe("session-selection-store", () => {
  it("sets the active/current session and marks it viewed", async () => {
    const markSessionViewed = vi.fn().mockResolvedValue(undefined);
    useSessionListStore.setState({
      markSessionViewed,
    } as Partial<ReturnType<typeof useSessionListStore.getState>>);

    await useSessionSelectionStore.getState().setActiveSession("session-1");

    expect(useSessionSelectionStore.getState().activeSessionId).toBe("session-1");
    expect(useSessionSelectionStore.getState().currentSessionId).toBe("session-1");
    expect(markSessionViewed).toHaveBeenCalledWith("session-1");
  });

  it("clears active/current session without touching message state", () => {
    useSessionSelectionStore.setState({
      activeSessionId: "session-1",
      currentSessionId: "session-1",
    });

    useSessionSelectionStore.getState().clearActiveSession();

    expect(useSessionSelectionStore.getState().activeSessionId).toBeNull();
    expect(useSessionSelectionStore.getState().currentSessionId).toBeNull();
  });

  it("tracks archived view selection separately from active session", () => {
    useSessionSelectionStore.getState().setViewingArchivedSession("archived-1");

    expect(useSessionSelectionStore.getState().viewingArchivedSessionId).toBe("archived-1");
  });
});
