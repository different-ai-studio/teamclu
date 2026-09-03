import { diffChars } from 'diff';

export interface HighlightSpan {
  from: number;
  to: number;
}

export interface AgentEditDiff {
  /** Replacement span in the OLD document. */
  from: number;
  to: number;
  /** Text that replaces `[from, to)`. */
  insert: string;
  /** Inserted spans, in NEW-document coordinates. */
  ranges: HighlightSpan[];
  addedChars: number;
  removedChars: number;
}

/** True when `code` is the first half of a surrogate pair. */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * PERF-17 — what an agent edit actually changed, without diffing the parts it
 * didn't.
 *
 * `diffChars(oldText, newText)` over a whole document is O(n·m) in the worst
 * case, and an agent edit is almost always a small change to a large file: a
 * heading rewritten, a paragraph inserted. The unchanged head and tail are the
 * overwhelming majority of both strings and are identical by construction, so
 * they are stripped by two linear scans and only the differing middle reaches
 * the diff. A one-line change in a 200 KB note goes from diffing 200 KB
 * against 200 KB to diffing a few dozen characters.
 *
 * The trimmed span is also what the editor should dispatch: replacing the
 * whole document makes CodeMirror rebuild every line and drops the cursor,
 * where replacing the changed span leaves the untouched lines — and the user's
 * place in them — alone.
 */
export function diffAgentEdit(oldText: string, newText: string): AgentEditDiff {
  const max = Math.min(oldText.length, newText.length);

  let prefix = 0;
  while (prefix < max && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix++;
  // Never split a surrogate pair: the halves are separate code units, and
  // cutting between them would hand the diff a lone surrogate.
  if (prefix > 0 && isHighSurrogate(oldText.charCodeAt(prefix - 1))) prefix--;

  let suffix = 0;
  while (
    suffix < max - prefix &&
    oldText.charCodeAt(oldText.length - 1 - suffix) ===
      newText.charCodeAt(newText.length - 1 - suffix)
  ) {
    suffix++;
  }
  if (suffix > 0 && isHighSurrogate(oldText.charCodeAt(oldText.length - suffix - 1))) suffix--;

  const oldMiddle = oldText.slice(prefix, oldText.length - suffix);
  const newMiddle = newText.slice(prefix, newText.length - suffix);

  const ranges: HighlightSpan[] = [];
  let addedChars = 0;
  let removedChars = 0;
  let offset = prefix;

  // Both empty means the two documents are equal; `diffChars('', '')` returns
  // no parts, so the loop below is simply skipped.
  for (const change of diffChars(oldMiddle, newMiddle)) {
    if (change.removed) {
      removedChars += change.value.length;
      continue;
    }
    if (change.added) {
      ranges.push({ from: offset, to: offset + change.value.length });
      addedChars += change.value.length;
    }
    offset += change.value.length;
  }

  return {
    from: prefix,
    to: oldText.length - suffix,
    insert: newMiddle,
    ranges,
    addedChars,
    removedChars,
  };
}
