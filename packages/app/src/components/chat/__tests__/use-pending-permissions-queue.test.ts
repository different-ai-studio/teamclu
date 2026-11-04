import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  flushPendingSessionRevisionsForTests,
  useV2StreamingStore,
} from "@/stores/v2-streaming-store";
import { useSessionStore } from "@/stores/session-store";
import { usePendingPermissionsQueue } from "../use-pending-permissions-queue";

const SID = "sess-1";
const ACTOR = "agent-1";

function store() {
  return useV2StreamingStore.getState();
}

function step(fn: () => void) {
  act(() => {
    fn();
    flushPendingSessionRevisionsForTests();
  });
}

describe("usePendingPermissionsQueue", () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [{ id: SID, messages: [] }] as never, pendingPermissions: [] });
    step(() => store().clearSession(SID));
  });

  // ComposerStack — and every agent strip under it — re-rendered on each frame
  // of a reply while this hook subscribed to the session revision, and once
  // more because the dismissed-ids filter always returned a fresh array.
  it("does not re-render on text deltas", () => {
    step(() => store().appendOutput(SID, ACTOR, "first"));
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return usePendingPermissionsQueue(SID);
    });
    const before = renders;
    for (let i = 0; i < 20; i++) step(() => store().appendOutput(SID, ACTOR, ` more ${i}`));
    expect(renders).toBe(before);
  });

  it("surfaces a permission request and drops it once cleared", () => {
    step(() => store().appendOutput(SID, ACTOR, "first"));
    const { result } = renderHook(() => usePendingPermissionsQueue(SID));
    expect(result.current.currentEntry).toBeNull();

    step(() =>
      store().setPermissionRequest(SID, ACTOR, {
        requestId: "r1",
        toolName: "bash",
        description: "ls",
        params: {},
      }),
    );
    expect(result.current.queuedCount).toBe(1);

    step(() => store().clearPermissionRequest(SID, ACTOR, "r1"));
    expect(result.current.queuedCount).toBe(0);
  });
});
