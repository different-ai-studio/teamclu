import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refreshMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/hooks/use-agent-app-changes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-agent-app-changes")>();
  return { ...actual, refreshAfterAgentAppChanges: refreshMock };
});

import { AGENT_APP_CHANGE_DEBOUNCE_MS } from "@/hooks/use-agent-app-changes";
import { noteAppAccessChanged, resetAppAccessInboxForTests } from "@/lib/apps/app-access-inbox";

describe("noteAppAccessChanged", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    refreshMock.mockClear();
  });
  afterEach(() => {
    resetAppAccessInboxForTests();
    vi.useRealTimers();
  });

  it("collapses a burst of access hints into one app list re-read", () => {
    noteAppAccessChanged("team-1", "app-1");
    noteAppAccessChanged("team-1", "app-2");
    expect(refreshMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(AGENT_APP_CHANGE_DEBOUNCE_MS);
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(refreshMock).toHaveBeenCalledWith([
      { teamId: "team-1", appId: "app-1" },
      { teamId: "team-1", appId: "app-2" },
    ]);
  });
});
