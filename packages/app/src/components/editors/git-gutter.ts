/**
 * Git Gutter Decorations for CodeMirror 6.
 *
 * Provides a CodeMirror extension that shows git status decorations
 * in the gutter (added, modified, deleted lines) based on a line-level
 * diff computed from the original (HEAD) and current content.
 */

import {
  type Extension,
  StateField,
  StateEffect,
  RangeSet,
} from '@codemirror/state';
import {
  EditorView,
  GutterMarker,
  gutter,
  type ViewUpdate,
} from '@codemirror/view';

/** Type of line change */
type LineChangeType = 'added' | 'modified' | 'deleted';

/** A line-level change entry */
interface LineChange {
  /** 1-based line number in the new (current) content */
  line: number;
  /** Type of change */
  type: LineChangeType;
}

/**
 * Compute line-level changes between two strings.
 * Returns an array of LineChange entries for the new content.
 *
 * Uses a simple LCS-based approach to detect added, removed, and modified lines.
 */
export function computeLineChanges(
  originalContent: string,
  currentContent: string,
): LineChange[] {
  if (originalContent === currentContent) return [];

  const oldLines = originalContent.split('\n');
  const newLines = currentContent.split('\n');
  const changes: LineChange[] = [];

  // Simple diff: walk through lines and detect changes
  const maxLen = Math.max(oldLines.length, newLines.length);
  let oi = 0;
  let ni = 0;

  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && ni < newLines.length) {
      if (oldLines[oi] === newLines[ni]) {
        // Same line - no change
        oi++;
        ni++;
      } else {
        // Lines differ - try to find where they sync up again
        const lookAhead = Math.min(10, maxLen - Math.max(oi, ni));
        let foundOld = -1;
        let foundNew = -1;

        // Look for current new line in upcoming old lines
        for (let i = 1; i <= lookAhead && oi + i < oldLines.length; i++) {
          if (oldLines[oi + i] === newLines[ni]) {
            foundOld = i;
            break;
          }
        }

        // Look for current old line in upcoming new lines
        for (let i = 1; i <= lookAhead && ni + i < newLines.length; i++) {
          if (newLines[ni + i] === oldLines[oi]) {
            foundNew = i;
            break;
          }
        }

        if (foundNew > 0 && (foundOld < 0 || foundNew <= foundOld)) {
          // Lines were added in new content
          for (let i = 0; i < foundNew; i++) {
            changes.push({ line: ni + i + 1, type: 'added' });
            ni++;
          }
        } else if (foundOld > 0) {
          // Lines were deleted from old content - mark as deleted at current position
          for (let i = 0; i < foundOld; i++) {
            oi++;
          }
          if (ni < newLines.length) {
            changes.push({ line: ni + 1, type: 'deleted' });
          }
        } else {
          // Line was modified
          changes.push({ line: ni + 1, type: 'modified' });
          oi++;
          ni++;
        }
      }
    } else if (ni < newLines.length) {
      // Extra lines in new content - all added
      changes.push({ line: ni + 1, type: 'added' });
      ni++;
    } else {
      // Extra lines removed from old content
      if (ni > 0) {
        // Mark the last line as having a deletion below
        const existingChange = changes.find(c => c.line === ni);
        if (!existingChange) {
          changes.push({ line: ni, type: 'deleted' });
        }
      }
      oi++;
    }
  }

  return changes;
}

// --- CodeMirror Extension ---

/** Effect to update git gutter changes */
const setGitChanges = StateEffect.define<LineChange[]>();

/** Gutter marker for added lines */
class AddedMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-git-gutter-added';
    return el;
  }
}

/** Gutter marker for modified lines */
class ModifiedMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-git-gutter-modified';
    return el;
  }
}

/** Gutter marker for deleted lines (triangle indicator) */
class DeletedMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-git-gutter-deleted';
    return el;
  }
}

const addedMarker = new AddedMarker();
const modifiedMarker = new ModifiedMarker();
const deletedMarker = new DeletedMarker();

/** State field that holds the current git change markers */
const gitGutterField = StateField.define<RangeSet<GutterMarker>>({
  create() {
    return RangeSet.empty;
  },
  update(markers, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setGitChanges)) {
        const changes = effect.value;
        const builder: { from: number; marker: GutterMarker }[] = [];

        for (const change of changes) {
          // Convert 1-based line to document position
          if (change.line > 0 && change.line <= tr.state.doc.lines) {
            const lineInfo = tr.state.doc.line(change.line);
            const marker =
              change.type === 'added'
                ? addedMarker
                : change.type === 'modified'
                  ? modifiedMarker
                  : deletedMarker;
            builder.push({ from: lineInfo.from, marker });
          }
        }

        // Sort by position and build RangeSet
        builder.sort((a, b) => a.from - b.from);
        return RangeSet.of(builder.map(b => b.marker.range(b.from)));
      }
    }
    // Map through document changes
    return markers.map(tr.changes);
  },
});

/** The gutter itself */
const gitGutter = gutter({
  class: 'cm-git-gutter',
  markers: (view) => view.state.field(gitGutterField),
});

/** Theme for git gutter markers */
const gitGutterTheme = EditorView.theme({
  '.cm-git-gutter': {
    width: '3px',
    marginRight: '2px',
  },
  '.cm-git-gutter-added': {
    width: '3px',
    height: '100%',
    backgroundColor: '#22c55e', // green-500
    borderRadius: '1px',
  },
  '.cm-git-gutter-modified': {
    width: '3px',
    height: '100%',
    backgroundColor: '#3b82f6', // blue-500
    borderRadius: '1px',
  },
  '.cm-git-gutter-deleted': {
    width: '0',
    height: '0',
    borderLeft: '4px solid transparent',
    borderRight: '4px solid transparent',
    borderTop: '4px solid #ef4444', // red-500
    position: 'relative',
    top: '100%',
  },
});

/**
 * Creates a CodeMirror extension for git gutter decorations.
 *
 * Usage:
 * ```ts
 * const extensions = [
 *   gitGutterExtension(),
 *   // ... other extensions
 * ];
 * ```
 *
 * To update the git changes, dispatch an effect:
 * ```ts
 * view.dispatch({
 *   effects: updateGitGutter(view, changes),
 * });
 * ```
 */
export function gitGutterExtension(): Extension {
  return [gitGutterField, gitGutter, gitGutterTheme];
}

/**
 * Dispatch git gutter changes to an EditorView.
 */
export function updateGitGutter(
  view: EditorView,
  changes: LineChange[],
): void {
  view.dispatch({
    effects: setGitChanges.of(changes),
  });
}

/**
 * Create an EditorView.updateListener that automatically computes
 * and updates git gutter decorations when the document changes.
 *
 * @param getOriginalContent - Function that returns the original (HEAD) content
 */
export function gitGutterAutoUpdate(
  getOriginalContent: () => string | null,
): Extension {
  let lastContent = '';

  return EditorView.updateListener.of((update: ViewUpdate) => {
    if (!update.docChanged) return;

    const original = getOriginalContent();
    if (original === null) return;

    const current = update.state.doc.toString();
    if (current === lastContent) return;
    lastContent = current;

    const changes = computeLineChanges(original, current);
    update.view.dispatch({
      effects: setGitChanges.of(changes),
    });
  });
}
