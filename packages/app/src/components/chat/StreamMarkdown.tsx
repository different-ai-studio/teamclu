import * as React from "react";
import { MessageResponse, StreamingTailContext } from "@/packages/ai/message";

/**
 * Streaming-friendly markdown. Paragraphs that have "closed" (a `\n\n`
 * boundary outside any code fence) render through a memoized block whose
 * source string never changes again, so ReactMarkdown re-parses only the
 * growing tail each frame — O(last paragraph) instead of O(whole reply).
 */
export function splitStableBlocks(text: string): {
  stable: string[];
  tail: string;
} {
  const segments = text.split("\n\n");
  if (segments.length === 1) return { stable: [], tail: text };
  const stable: string[] = [];
  let current = "";
  // Running fence count for the block being accumulated. PERF-13: this used to
  // re-run the fence regex over the whole of `current` on every segment, so a
  // long fenced block was rescanned once per blank line inside it — quadratic
  // in the block, on every streaming frame. Joining with "\n\n" introduces no
  // line start that was not already the start of a segment, so summing each
  // segment's own matches gives exactly the same count for one pass over the
  // text.
  let openFences = 0;
  for (let i = 0; i < segments.length - 1; i++) {
    current = current ? `${current}\n\n${segments[i]}` : segments[i];
    // A block is only "closed" when its fence markers are balanced — an odd
    // count means we're mid-code-fence and the `\n\n` is inside it.
    // Count fence markers (``` / ~~~) at line start, allowing CommonMark's ≤3
    // leading spaces. A block is only "closed" when they balance — odd = the
    // \n\n is inside an open code fence, so don't split there. Fences indented
    // >3 spaces (deep list nesting) may briefly mis-split mid-stream; self-heals
    // on finalize (the finalized message bypasses the splitter).
    openFences += segments[i].match(/^ {0,3}(```|~~~)/gm)?.length ?? 0;
    if (openFences % 2 === 0) {
      stable.push(current);
      current = "";
      openFences = 0;
    }
  }
  const lastSegment = segments[segments.length - 1];
  const tail = current ? `${current}\n\n${lastSegment}` : lastSegment;
  return { stable, tail };
}

const StableBlock = React.memo(function StableBlock({
  content,
}: {
  content: string;
}) {
  return <MessageResponse>{content}</MessageResponse>;
});

/**
 * Growing tail above this size skips ReactMarkdown while streaming (plain text)
 * to avoid O(n) re-parse of open code fences. Finalized messages bypass this.
 */
export const STREAM_TAIL_PLAIN_TEXT_THRESHOLD = 4000;

export function StreamMarkdown({ text }: { text: string }) {
  // Defer streaming updates so composer typing outranks re-renders (React 19).
  const deferredText = React.useDeferredValue(text);
  const { stable, tail } = React.useMemo(
    () => splitStableBlocks(deferredText),
    [deferredText],
  );
  const usePlainTail = tail.length > STREAM_TAIL_PLAIN_TEXT_THRESHOLD;
  return (
    <>
      {stable.map((block, i) => (
        // Index keys are safe: blocks are append-only and immutable once closed.
        <StableBlock key={i} content={block} />
      ))}
      {tail ? (
        // The tail is still growing — heavy renderers (Shiki/Mermaid) skip
        // per-frame work under this flag and highlight once the block closes
        // into a StableBlock above.
        <StreamingTailContext.Provider value={true}>
          {usePlainTail ? (
            <pre className="m-0 whitespace-pre-wrap break-words font-sans text-[13.5px] leading-[1.7] text-foreground">
              {tail}
            </pre>
          ) : (
            <MessageResponse>{tail}</MessageResponse>
          )}
        </StreamingTailContext.Provider>
      ) : null}
    </>
  );
}
