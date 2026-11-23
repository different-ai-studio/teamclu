import { describe, it, expect } from 'vitest';
import { EditorState, Transaction } from '@codemirror/state';
import { history, historyField, undo } from '@codemirror/commands';
import { computeMinimalChange } from '../utils';

/**
 * Reproduce the undo behavior of CodeEditor's external content sync.
 *
 * The bug (commit 47af973 partially fixed): when the editor's `content` prop
 * differs from the editor's doc, a sync transaction replaces the doc. Even
 * with `Transaction.addToHistory.of(false)`, CM6's history extension calls
 * `state.addMapping(tr.changes.desc)` which maps every prior history entry
 * through the new transaction's changes. A wholesale replacement collapses
 * every prior entry to an empty change, dropping them all — leaving only
 * the most recent edit available for undo.
 *
 * The fix: dispatch a minimal diff (common prefix/suffix shrink) instead of
 * a wholesale replacement, so history outside the changed region survives.
 */

function applyExternalSync(
  state: EditorState,
  newContent: string,
  mode: 'wholesale' | 'minimal-diff',
): EditorState {
  const currentDoc = state.doc.toString();
  if (currentDoc === newContent) return state;
  const change =
    mode === 'wholesale'
      ? { from: 0, to: currentDoc.length, insert: newContent }
      : computeMinimalChange(currentDoc, newContent)!;
  return state.update({
    changes: change,
    annotations: Transaction.addToHistory.of(false),
  }).state;
}

function makeEdit(state: EditorState, change: { from: number; to: number; insert: string }) {
  return state.update({
    changes: change,
    userEvent: 'input.type',
    // Force each test edit into its own history group.
    annotations: Transaction.time.of(state.field(historyField).prevTime + 10_000),
  }).state;
}

function runUndo(state: EditorState): EditorState {
  let result = state;
  undo({
    state,
    dispatch: (tr) => {
      result = tr.state;
    },
  });
  return result;
}

describe('CodeEditor external content sync — history preservation', () => {
  const baseExtensions = [history()];

  it('round-trip sync (no actual diff) does not drop history', () => {
    let state = EditorState.create({ doc: '', extensions: baseExtensions });
    state = makeEdit(state, { from: 0, to: 0, insert: 'a' });
    state = makeEdit(state, { from: 1, to: 1, insert: 'b' });
    state = makeEdit(state, { from: 2, to: 2, insert: 'c' });

    // No-op sync (doc already matches) — both modes are equivalent here.
    state = applyExternalSync(state, 'abc', 'minimal-diff');

    state = runUndo(state);
    expect(state.doc.toString()).toBe('ab');
    state = runUndo(state);
    expect(state.doc.toString()).toBe('a');
    state = runUndo(state);
    expect(state.doc.toString()).toBe('');
  });

  it('REGRESSION: wholesale sync drops history (only one undo works)', () => {
    let state = EditorState.create({ doc: '', extensions: baseExtensions });
    state = makeEdit(state, { from: 0, to: 0, insert: 'a' });
    state = makeEdit(state, { from: 1, to: 1, insert: 'b' });
    state = makeEdit(state, { from: 2, to: 2, insert: 'c' });

    // External sync that DOES change the doc, using the old wholesale strategy.
    // Even a one-character change at the end becomes a from:0 to:3 replacement.
    state = applyExternalSync(state, 'abcd', 'wholesale');

    // Pre-fix behavior: undo only goes back one step.
    state = runUndo(state);
    expect(state.doc.toString()).not.toBe('ab');
    // History is gone — further undos do nothing.
    const before = state.doc.toString();
    state = runUndo(state);
    expect(state.doc.toString()).toBe(before);
  });

  it('FIX: minimal-diff sync preserves history outside the changed region', () => {
    let state = EditorState.create({ doc: '', extensions: baseExtensions });
    state = makeEdit(state, { from: 0, to: 0, insert: 'a' });
    state = makeEdit(state, { from: 1, to: 1, insert: 'b' });
    state = makeEdit(state, { from: 2, to: 2, insert: 'c' });

    // External one-character append using minimal-diff: the change is just
    // {from: 3, to: 3, insert: 'd'}, which doesn't overlap any prior history
    // entry, so addMapping leaves prior entries intact.
    state = applyExternalSync(state, 'abcd', 'minimal-diff');

    state = runUndo(state);
    expect(state.doc.toString()).toBe('abd');
    state = runUndo(state);
    expect(state.doc.toString()).toBe('ad');
    state = runUndo(state);
    expect(state.doc.toString()).toBe('d');
  });
});

describe('computeMinimalChange', () => {
  it('returns null for identical strings', () => {
    expect(computeMinimalChange('hello', 'hello')).toBeNull();
  });

  it('finds an append at the end', () => {
    expect(computeMinimalChange('abc', 'abcd')).toEqual({
      from: 3,
      to: 3,
      insert: 'd',
    });
  });

  it('finds a prepend at the start', () => {
    expect(computeMinimalChange('abc', 'xabc')).toEqual({
      from: 0,
      to: 0,
      insert: 'x',
    });
  });

  it('finds a middle replacement', () => {
    expect(computeMinimalChange('hello world', 'hello there')).toEqual({
      from: 6,
      to: 11,
      insert: 'there',
    });
  });

  it('finds a deletion', () => {
    expect(computeMinimalChange('abcdef', 'abef')).toEqual({
      from: 2,
      to: 4,
      insert: '',
    });
  });

  it('handles empty old string', () => {
    expect(computeMinimalChange('', 'abc')).toEqual({
      from: 0,
      to: 0,
      insert: 'abc',
    });
  });

  it('handles empty new string', () => {
    expect(computeMinimalChange('abc', '')).toEqual({
      from: 0,
      to: 3,
      insert: '',
    });
  });
});
