import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bufferStreamDelta,
  flushAllStreamDeltas,
  flushStreamDeltasFor,
  __resetStreamDeltaBufferForTests,
} from "@/lib/stream/stream-delta-buffer";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";

describe("stream-delta-buffer", () => {
  let rafCallbacks: FrameRequestCallback[];
  beforeEach(() => {
    rafCallbacks = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    __resetStreamDeltaBufferForTests();
    useV2StreamingStore.setState({ byKey: {}, archived: [], revisionBySession: {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  const fireRaf = () => { rafCallbacks.splice(0).forEach((cb) => cb(0)); };
  const entry = () => useV2StreamingStore.getState().byKey["s1::a1"];

  it("coalesces a burst into one store mutation per kind", () => {
    const spy = vi.spyOn(useV2StreamingStore.getState(), "appendOutputBatch");
    bufferStreamDelta("output", "s1", "a1", "alpha ");
    bufferStreamDelta("output", "s1", "a1", "beta ");
    bufferStreamDelta("output", "s1", "a1", "gamma");
    expect(entry()).toBeUndefined();
    fireRaf();
    expect(spy).toHaveBeenCalledTimes(1);
    // byte-identical to N unbatched appendOutput calls: the store folds each
    // delta incrementally, collapsed into a single mutation.
    expect(entry()?.outputText).toBe("alpha beta gamma");
  });

  it("preserves output/thinking interleaving order", () => {
    bufferStreamDelta("thinking", "s1", "a1", "plan…");
    bufferStreamDelta("output", "s1", "a1", "answer");
    fireRaf();
    const parts = entry()!.parts;
    expect(parts[0].type).toBe("reasoning");
    expect(parts[1].type).toBe("text");
  });

  it("flushStreamDeltasFor applies synchronously for that key only", () => {
    bufferStreamDelta("output", "s1", "a1", "A");
    bufferStreamDelta("output", "s2", "a2", "B");
    flushStreamDeltasFor("s1", "a1");
    expect(entry()?.outputText).toBe("A");
    expect(useV2StreamingStore.getState().byKey["s2::a2"]).toBeUndefined();
    flushAllStreamDeltas();
    expect(useV2StreamingStore.getState().byKey["s2::a2"]?.outputText).toBe("B");
  });

  it("plain-concats buffered live chunks (overlap dedup is resume-only)", () => {
    // Live deltas are eventId-deduped upstream, so the buffer must NOT strip
    // overlapping suffixes — that would swallow genuinely repeated content.
    bufferStreamDelta("output", "s1", "a1", "abcdef");
    bufferStreamDelta("output", "s1", "a1", "defghi");
    fireRaf();
    expect(entry()?.outputText).toBe("abcdefdefghi");
  });

  it("matches unbatched fold when a run overlaps existing tail (no silent drop)", () => {
    // seed existing entry text via a prior committed delta
    useV2StreamingStore.getState().appendOutput("s1", "a1", "The over");
    bufferStreamDelta("output", "s1", "a1", "The");
    bufferStreamDelta("output", "s1", "a1", " over");
    fireRaf();
    // unbatched fold: overlap("The over","The")="The overThe", then +" over"="The overThe over"
    expect(entry()?.outputText).toBe("The overThe over");
  });

  it("flushStreamDeltasFor drains buffered text before a synchronous tool event", () => {
    bufferStreamDelta("output", "s1", "a1", "before tool");
    flushStreamDeltasFor("s1", "a1");
    useV2StreamingStore.getState().pushToolUse("s1", "a1", {
      toolId: "t1",
      toolName: "bash",
      description: "",
      params: {},
    });
    const parts = entry()!.parts;
    expect(parts[0].type).toBe("text");
    expect(parts[1].type).toBe("tool-call");
  });

  it("flushes via microtask when requestAnimationFrame is unavailable", async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("requestAnimationFrame", undefined as unknown as typeof requestAnimationFrame);
    __resetStreamDeltaBufferForTests();
    useV2StreamingStore.setState({ byKey: {}, archived: [], revisionBySession: {} });
    bufferStreamDelta("output", "s1", "a1", "hello");
    expect(entry()).toBeUndefined();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(entry()?.outputText).toBe("hello");
  });
});
