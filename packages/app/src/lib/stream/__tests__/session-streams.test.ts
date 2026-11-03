import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  flushPendingSessionRevisionsForTests,
  useV2StreamingStore,
} from "@/stores/v2-streaming-store";
import { useLiveStreamEntry, useSessionStreams } from "../session-streams";

const SID = "sess-1";
const ACTOR = "agent-1";

function store() {
  return useV2StreamingStore.getState();
}

function delta(text: string) {
  act(() => {
    store().appendOutput(SID, ACTOR, text);
    flushPendingSessionRevisionsForTests();
  });
}

describe("useSessionStreams", () => {
  beforeEach(() => {
    act(() => {
      store().clearSession(SID);
      flushPendingSessionRevisionsForTests();
    });
  });

  // ChatPanel and SessionChatColumn derive the dock's agent list, the plan and
  // the permission queue from this. Subscribing them to the session revision
  // re-rendered the whole column and composer on every frame of a reply.
  it("does not re-render on text deltas", () => {
    delta("first");
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useSessionStreams(SID);
    });
    const before = renders;
    for (let i = 0; i < 20; i++) delta(` more ${i}`);
    expect(renders).toBe(before);
    expect(result.current.map((e) => e.actorId)).toEqual([ACTOR]);
  });

  it("re-renders when the plan, a permission or liveness changes", () => {
    delta("first");
    const { result } = renderHook(() => useSessionStreams(SID));

    act(() => {
      store().setPlan(SID, ACTOR, [{ content: "step", status: "pending", priority: "medium" }]);
      flushPendingSessionRevisionsForTests();
    });
    expect(result.current[0]?.planEntries).toHaveLength(1);

    act(() => {
      store().setPermissionRequest(SID, ACTOR, {
        requestId: "r1",
        toolName: "bash",
        description: "",
        params: {},
      });
      flushPendingSessionRevisionsForTests();
    });
    expect(Object.keys(result.current[0]?.pendingPermissionsByRequestId ?? {})).toEqual(["r1"]);

    act(() => {
      store().finalize(SID, ACTOR);
      flushPendingSessionRevisionsForTests();
    });
    expect(result.current.some((e) => e.actorId === ACTOR && e.active)).toBe(false);
  });

  it("returns nothing without a session", () => {
    const { result } = renderHook(() => useSessionStreams(null));
    expect(result.current).toEqual([]);
  });
});

describe("useLiveStreamEntry", () => {
  it("follows each delta of one actor's entry", () => {
    act(() => store().clearSession(SID));
    const { result } = renderHook(() => useLiveStreamEntry(SID, ACTOR));
    expect(result.current).toBeUndefined();
    delta("ab");
    delta("cd");
    expect(result.current?.outputText).toBe("abcd");
  });
});
