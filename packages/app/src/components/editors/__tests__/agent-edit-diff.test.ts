import { describe, expect, it } from 'vitest';
import { diffChars } from 'diff';
import { diffAgentEdit } from '../agent-edit-diff';

/** The un-trimmed computation this replaces, kept as the oracle. */
function reference(oldText: string, newText: string) {
  const ranges: { from: number; to: number }[] = [];
  let offset = 0;
  let addedChars = 0;
  let removedChars = 0;
  for (const change of diffChars(oldText, newText)) {
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
  return { ranges, addedChars, removedChars };
}

function applied(oldText: string, d: ReturnType<typeof diffAgentEdit>) {
  return oldText.slice(0, d.from) + d.insert + oldText.slice(d.to);
}

describe('diffAgentEdit', () => {
  const cases: Array<[string, string, string]> = [
    ['insert in the middle', 'hello world', 'hello brave world'],
    ['delete in the middle', 'hello brave world', 'hello world'],
    ['append', '# Title\n\nbody', '# Title\n\nbody\n\nmore'],
    ['prepend', 'body', '# Title\n\nbody'],
    ['replace everything', 'aaaa', 'bbbb'],
    ['empty to content', '', 'new file'],
    ['content to empty', 'old file', ''],
    ['single char change', 'abcdef', 'abXdef'],
    ['repeated affix text', 'ababab', 'abab'],
    ['multibyte', '标题\n正文', '标题\n新的正文'],
    ['emoji (surrogate pairs)', 'a👍b', 'a👍👍b'],
  ];

  for (const [name, oldText, newText] of cases) {
    it(`reconstructs the new document: ${name}`, () => {
      const d = diffAgentEdit(oldText, newText);
      expect(applied(oldText, d)).toBe(newText);
    });

    it(`counts the same added/removed as an untrimmed diff: ${name}`, () => {
      const d = diffAgentEdit(oldText, newText);
      const ref = reference(oldText, newText);
      expect(d.addedChars).toBe(ref.addedChars);
      expect(d.removedChars).toBe(ref.removedChars);
    });

    it(`highlights the inserted text: ${name}`, () => {
      const d = diffAgentEdit(oldText, newText);
      const highlighted = d.ranges.map((r) => newText.slice(r.from, r.to)).join('');
      expect(highlighted.length).toBe(d.addedChars);
      // Every range is inside the new document and non-empty.
      for (const r of d.ranges) {
        expect(r.from).toBeGreaterThanOrEqual(0);
        expect(r.to).toBeLessThanOrEqual(newText.length);
        expect(r.to).toBeGreaterThan(r.from);
      }
    });
  }

  it('reports an empty edit for identical documents', () => {
    const d = diffAgentEdit('same', 'same');
    expect(d.from).toBe(d.to);
    expect(d.insert).toBe('');
    expect(d.ranges).toEqual([]);
    expect(d.addedChars).toBe(0);
    expect(d.removedChars).toBe(0);
  });

  it('touches only the changed span of a large document', () => {
    const head = 'x'.repeat(50_000);
    const tail = 'y'.repeat(50_000);
    const d = diffAgentEdit(`${head}\nmiddle\n${tail}`, `${head}\nMIDDLE\n${tail}`);
    // The replacement span must not span the whole document.
    expect(d.to - d.from).toBeLessThan(100);
    expect(d.from).toBeGreaterThan(49_000);
  });

  it('marks the inserted emoji, not a lone surrogate half', () => {
    const d = diffAgentEdit('a👍b', 'a👍👍b');
    const highlighted = d.ranges.map((r) => 'a👍👍b'.slice(r.from, r.to)).join('');
    expect(highlighted).toBe('👍');
  });
});
