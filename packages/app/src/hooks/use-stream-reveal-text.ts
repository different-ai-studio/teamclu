import { useEffect, useReducer, useRef } from "react";
import { adaptiveCharsPerFrame } from "@/lib/stream/adaptive-chars-per-frame";

/**
 * Gradually reveals `targetText` while `active` (v2 live bubble / thinking).
 * Matches the legacy session typewriter cadence in streaming.ts.
 *
 * PERF: render-driven instead of running its own setState-per-frame rAF loop
 * on top of the store's rAF delta batching (which already re-renders the
 * bubble once per frame while deltas arrive). Each render advances the
 * revealed length; a rAF only kicks in to keep the reveal moving when the
 * store goes quiet but a backlog remains. This halves renders per frame
 * during active streaming (one render instead of store-render + reveal-render).
 */
export function useStreamRevealText(targetText: string, active: boolean): string {
  const displayedLenRef = useRef(active ? 0 : targetText.length);
  const lastAdvanceTsRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const [, forceRender] = useReducer((n: number) => n + 1, 0);

  if (!active || targetText.length < displayedLenRef.current) {
    // Finalized, or the stream was reset/replaced — show everything.
    displayedLenRef.current = targetText.length;
  } else if (targetText.length > displayedLenRef.current) {
    // Advance at most once per frame (~12ms guard) so a store-driven render
    // and the fallback rAF landing in the same frame don't double-step, and
    // StrictMode double-renders don't double the reveal speed.
    const now = performance.now();
    if (now - lastAdvanceTsRef.current >= 12) {
      lastAdvanceTsRef.current = now;
      const backlog = targetText.length - displayedLenRef.current;
      displayedLenRef.current = Math.min(
        targetText.length,
        displayedLenRef.current + adaptiveCharsPerFrame(backlog),
      );
    }
  }

  useEffect(() => {
    if (!active || displayedLenRef.current >= targetText.length) return;
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      forceRender();
    });
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  });

  return active ? targetText.slice(0, displayedLenRef.current) : targetText;
}
