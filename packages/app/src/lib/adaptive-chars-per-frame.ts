// Adaptive typewriter speed for streamed text:
// - BASE_CHARS_PER_FRAME: minimum chars per frame (smooth typing feel at low throughput)
// - When the backlog grows past CATCHUP_THRESHOLD, reveal extra chars proportional
//   to the backlog so the UI never falls more than ~0.5 s behind the real stream.
// At 60 fps: base alone = 180 chars/s. With a 500-char backlog:
// ceil(3 + (500 - 120) * 0.05) = 22 chars/frame = 1320 chars/s.
const BASE_CHARS_PER_FRAME = 3;
const CATCHUP_THRESHOLD = 120; // backlog chars before catch-up kicks in (~0.67 s at base rate)
const CATCHUP_RATIO = 0.05; // fraction of the excess backlog to drain per frame

/** Compute how many chars to reveal this frame, adapting to the backlog. */
export function adaptiveCharsPerFrame(bufferLen: number): number {
  if (bufferLen <= CATCHUP_THRESHOLD) return Math.min(BASE_CHARS_PER_FRAME, bufferLen);
  const excess = bufferLen - CATCHUP_THRESHOLD;
  return Math.min(bufferLen, Math.ceil(BASE_CHARS_PER_FRAME + excess * CATCHUP_RATIO));
}
