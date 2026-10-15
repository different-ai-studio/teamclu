/**
 * Splits markdown at blank lines into blocks that can render independently.
 *
 * A streaming reply re-renders on every published chunk, and
 * react-native-markdown-display re-parses its whole input each time and keys
 * every node from a global counter — so the entire reply's native views were
 * torn down and rebuilt per chunk, with cost growing with the reply. Rendered
 * block by block, only the block still being written changes; the finished
 * ones keep their text and skip rendering altogether.
 *
 * Blank lines inside a ``` / ~~~ fence stay in the fence's block. A list whose
 * items are separated by blank lines becomes several lists, which looks the
 * same; an ordered list keeps its numbers because markdown honours each list's
 * first number.
 */
export function splitMarkdownBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    if (current.length > 0) blocks.push(current.join("\n"));
    current = [];
  };

  for (const line of text.split("\n")) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      current.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      current.push(line);
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}
