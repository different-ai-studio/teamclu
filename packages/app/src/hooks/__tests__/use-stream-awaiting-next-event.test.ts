import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STREAM_AWAITING_NEXT_EVENT_MS,
  useStreamAwaitingNextEvent,
} from "@/hooks/use-stream-awaiting-next-event";

describe("use-stream-awaiting-next-event", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false while inactive", () => {
    const { result } = renderHook(() => useStreamAwaitingNextEvent(false, Date.now()));
    expect(result.current).toBe(false);
  });

  it("becomes true after idleMs without a content revision bump", () => {
    const { result, rerender } = renderHook(
      ({ revision }) => useStreamAwaitingNextEvent(true, revision),
      { initialProps: { revision: "a" } },
    );
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(STREAM_AWAITING_NEXT_EVENT_MS);
    });
    expect(result.current).toBe(true);

    rerender({ revision: "b" });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(STREAM_AWAITING_NEXT_EVENT_MS);
    });
    expect(result.current).toBe(true);
  });

  it("does not reset when revision is unchanged", () => {
    const { result, rerender } = renderHook(
      ({ revision }) => useStreamAwaitingNextEvent(true, revision),
      { initialProps: { revision: "same" } },
    );
    act(() => {
      vi.advanceTimersByTime(STREAM_AWAITING_NEXT_EVENT_MS);
    });
    expect(result.current).toBe(true);
    rerender({ revision: "same" });
    expect(result.current).toBe(true);
  });

  it("clears when the stream becomes inactive", () => {
    const { result, rerender } = renderHook(
      ({ active, revision }) => useStreamAwaitingNextEvent(active, revision),
      { initialProps: { active: true, revision: "a" } },
    );
    act(() => {
      vi.advanceTimersByTime(STREAM_AWAITING_NEXT_EVENT_MS);
    });
    expect(result.current).toBe(true);
    rerender({ active: false, revision: "a" });
    expect(result.current).toBe(false);
  });
});
