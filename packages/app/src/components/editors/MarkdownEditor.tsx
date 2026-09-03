/**
 * MarkdownEditor — CodeMirror 6 markdown source editor.
 *
 * Features:
 * - Markdown syntax highlighting (@codemirror/lang-markdown)
 * - Agent change highlighting via character-level diff (StateField + Decoration.mark)
 * - Image paste auto-upload to _assets/
 * - Wiki link [[name]] click-to-navigate
 * - Line numbers, line wrapping, search panel, history, fold gutter
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { EditorState, StateEffect, StateField, Transaction, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { search, searchKeymap } from '@codemirror/search';
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { diffAgentEdit } from './agent-edit-diff';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { EditorProps } from './types';
import { detectClipboardImage, saveClipboardImage } from './image-paste-handler';
import { parseWikiLinkText } from '@/lib/wiki-link-utils';
import { resolveWikiLinkPath, createNoteFromLink } from '@/lib/wiki-link-resolver';
import {
  globalTeamKnowledgeShareDir,
  teamContentRootForPath,
} from '@/lib/team-skill-paths';
import { useWorkspaceStore } from '@/stores/workspace';

export interface MarkdownEditorHandle {
  /** Apply external content with diff-based agent highlighting */
  applyAgentChange: (newMarkdown: string) => Promise<void>;
  /** Get current markdown content */
  getMarkdown: () => string;
}

/** Percent of doc that can change before we skip highlighting (too noisy). */
const LARGE_CHANGE_THRESHOLD = 50;
/** Time before agent highlights auto-fade. */
const FADE_TIMEOUT = 5000;

interface HighlightRange {
  from: number;
  to: number;
}

interface HighlightState {
  decorations: DecorationSet;
  batches: Map<string, HighlightRange[]>;
}

const addAgentHighlights = StateEffect.define<{ ranges: HighlightRange[]; batchId: string }>();
const fadeAgentBatch = StateEffect.define<{ batchId: string }>();
const clearAllHighlights = StateEffect.define<null>();

const agentHighlightMark = Decoration.mark({ class: 'agent-highlight' });

const agentHighlightField = StateField.define<HighlightState>({
  create() {
    return { decorations: Decoration.none, batches: new Map() };
  },
  update(value, tr) {
    let decorations = value.decorations.map(tr.changes);
    let batches = value.batches;

    for (const effect of tr.effects) {
      if (effect.is(addAgentHighlights)) {
        const { ranges, batchId } = effect.value;
        const docLen = tr.state.doc.length;
        const valid = ranges.filter((r) => r.from < docLen && r.to <= docLen && r.from < r.to);
        if (valid.length === 0) continue;
        const marks = valid.map((r) => agentHighlightMark.range(r.from, r.to));
        decorations = decorations.update({ add: marks, sort: true });
        const newBatches = new Map(batches);
        newBatches.set(batchId, valid);
        batches = newBatches;
      } else if (effect.is(fadeAgentBatch)) {
        const { batchId } = effect.value;
        if (!batches.has(batchId)) continue;
        const newBatches = new Map(batches);
        newBatches.delete(batchId);
        const remaining: ReturnType<typeof agentHighlightMark.range>[] = [];
        const docLen = tr.state.doc.length;
        for (const ranges of newBatches.values()) {
          for (const r of ranges) {
            if (r.from < docLen && r.to <= docLen) {
              remaining.push(agentHighlightMark.range(r.from, r.to));
            }
          }
        }
        decorations = Decoration.set(remaining, true);
        batches = newBatches;
      } else if (effect.is(clearAllHighlights)) {
        decorations = Decoration.none;
        batches = new Map();
      }
    }

    return { decorations, batches };
  },
  provide: (f) => EditorView.decorations.from(f, (s) => s.decorations),
});

const wikiLinkMatcher = new MatchDecorator({
  regexp: /\[\[([^\]\n]+)\]\]/g,
  decoration: () => Decoration.mark({ class: 'cm-wiki-link' }),
});

const wikiLinkPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = wikiLinkMatcher.createDeco(view);
    }
    update(update: ViewUpdate) {
      this.decorations = wikiLinkMatcher.updateDeco(update, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

function handleWikiLinkClick(event: MouseEvent, filePath?: string): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  const el = target.closest('.cm-wiki-link');
  if (!el || !el.textContent) return false;

  const match = el.textContent.match(/^\[\[([\s\S]+?)\]\]$/);
  if (!match) return false;

  const parts = parseWikiLinkText(match[1]);
  const workspace = useWorkspaceStore.getState();
  const heading = parts.heading ?? undefined;

  void (async () => {
    try {
      // Resolve inside the knowledge tree the open document belongs to: the
      // real `~/.amuxd[-<brand>]/teams/<id>/shared/knowledge` dir for a document
      // opened from the Knowledge column, the `team-knowledge` symlink for one
      // opened from the workspace file panel. Resolving both against the
      // symlink would open the same note under a second path — two tabs over
      // one file. A document outside any knowledge tree still links into the
      // team's notes, and does so by the real directory.
      const root =
        (filePath
          ? teamContentRootForPath(filePath, { workspacePath: workspace.workspacePath })
          : null) ?? (await globalTeamKnowledgeShareDir());
      if (!root) return;

      const resolved = await resolveWikiLinkPath(root, parts.target);
      if (resolved) {
        await workspace.selectFile(resolved, undefined, heading);
        return;
      }
      const newPath = await createNoteFromLink(root, parts.target);
      await workspace.selectFile(newPath, undefined, heading);
    } catch (err) {
      console.error('[MarkdownEditor] wiki-link resolution failed:', err);
      // Surfaced, not swallowed: the common failure is "the team knowledge dir
      // isn't there yet", and creating the note anyway would materialize a
      // directory the daemon means to own. Silence would just read as a dead
      // click.
      toast.error(String(err instanceof Error ? err.message : err));
    }
  })();
  return true;
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, EditorProps>(
  function MarkdownEditor(
    { content, filePath, onChange, readOnly = false, isDark = false, targetLine },
    ref,
  ) {
    const { t } = useTranslation();
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const filePathRef = useRef(filePath);
    filePathRef.current = filePath;
    const isExternalUpdate = useRef(false);
    const batchCounterRef = useRef(0);

    useImperativeHandle(
      ref,
      () => ({
        applyAgentChange: async (newMarkdown: string) => {
          const view = viewRef.current;
          if (!view) return;
          const oldText = view.state.doc.toString();
          if (oldText === newMarkdown) return;

          // PERF-17: diff the changed span only, and dispatch that span rather
          // than the whole document — a full replacement rebuilds every line
          // and throws the cursor to the top for a one-word agent edit.
          const edit = diffAgentEdit(oldText, newMarkdown);
          const ranges: HighlightRange[] = edit.ranges;

          const changedChars = Math.max(edit.addedChars, edit.removedChars);
          const totalChars = Math.max(oldText.length, newMarkdown.length, 1);
          const changePercent = (changedChars / totalChars) * 100;
          const shouldHighlight = changePercent <= LARGE_CHANGE_THRESHOLD && ranges.length > 0;
          const batchId = `agent-${Date.now()}-${++batchCounterRef.current}`;

          isExternalUpdate.current = true;
          view.dispatch({
            changes: { from: edit.from, to: edit.to, insert: edit.insert },
            effects: shouldHighlight ? [addAgentHighlights.of({ ranges, batchId })] : [],
            annotations: Transaction.addToHistory.of(false),
          });
          isExternalUpdate.current = false;

          if (shouldHighlight) {
            setTimeout(() => {
              const v = viewRef.current;
              if (v) v.dispatch({ effects: [fadeAgentBatch.of({ batchId })] });
            }, FADE_TIMEOUT);
          }
        },
        getMarkdown: () => {
          const view = viewRef.current;
          return view ? view.state.doc.toString() : content;
        },
      }),
      [content],
    );

    useEffect(() => {
      if (!containerRef.current) return;

      const extensions: Extension[] = [
        lineNumbers(),
        highlightActiveLine(),
        drawSelection(),
        bracketMatching(),
        foldGutter(),
        indentOnInput(),
        history(),
        closeBrackets(),
        search(),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        EditorView.lineWrapping,
        agentHighlightField,
        wikiLinkPlugin,
        EditorView.domEventHandlers({
          paste(event, view) {
            const file = detectClipboardImage(event);
            if (!file) return false;
            const fp = filePathRef.current;
            if (!fp) return false;
            event.preventDefault();
            saveClipboardImage(file, fp)
              .then((result) => {
                if (result.markdownSyntax) {
                  const insertPos = view.state.selection.main.head;
                  view.dispatch({
                    changes: { from: insertPos, insert: result.markdownSyntax },
                    selection: { anchor: insertPos + result.markdownSyntax.length },
                  });
                } else {
                  toast.error(t('editor.imagePasteFailed', 'Failed to save pasted image'));
                  console.error('[MarkdownEditor] image paste failed:', result.error);
                }
              })
              .catch((err) => {
                console.error('[MarkdownEditor] image paste failed:', err);
              });
            return true;
          },
          mousedown(event) {
            return handleWikiLinkClick(event, filePathRef.current ?? undefined);
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !isExternalUpdate.current) {
            onChangeRef.current?.(update.state.doc.toString());
          }
        }),
      ];

      if (isDark) extensions.push(oneDark);
      if (readOnly) extensions.push(EditorState.readOnly.of(true));

      extensions.push(
        EditorView.theme({
          '&': { height: '100%', fontSize: '13.5px' },
          '.cm-content': {
            fontFamily: 'var(--font-sans)',
            padding: '12px 16px',
            lineHeight: '1.7',
            color: 'var(--foreground)',
          },
          '.cm-scroller': { overflow: 'auto' },
          '.cm-gutters': {
            backgroundColor: 'transparent',
            border: 'none',
            color: 'var(--faint)',
          },
          '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ink-2)' },
          '.cm-activeLine': { backgroundColor: 'color-mix(in oklch, var(--foreground), transparent 96%)' },
          '.cm-wiki-link': {
            color: 'var(--primary)',
            textDecoration: 'underline',
            textDecorationStyle: 'dotted',
            cursor: 'pointer',
          },
          '.cm-wiki-link:hover': { textDecorationStyle: 'solid' },
          '.cm-panels': {
            backgroundColor: 'var(--muted)',
            borderBottom: '1px solid var(--border)',
            color: 'var(--foreground)',
          },
          '.cm-search': {
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: '6px',
            padding: '8px 10px',
            fontSize: '12px',
            fontFamily: 'inherit',
          },
          '.cm-search input[type="text"]': {
            height: '32px',
            minWidth: '180px',
            padding: '0 10px',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            backgroundColor: 'var(--background)',
            color: 'var(--foreground)',
            fontSize: '12px',
            outline: 'none',
          },
          '.cm-search input[type="text"]:focus': {
            borderColor: 'var(--ring)',
            boxShadow: '0 0 0 2px color-mix(in oklch, var(--ring), transparent 75%)',
          },
          '.cm-search button': {
            height: '28px',
            padding: '0 10px',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            backgroundColor: 'var(--background)',
            color: 'var(--foreground)',
            fontSize: '12px',
          },
          '.cm-search button:hover': { backgroundColor: 'var(--muted)' },
          '.cm-search label': {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            fontSize: '12px',
            color: 'var(--muted-foreground)',
          },
          '.cm-searchMatch': { backgroundColor: 'color-mix(in oklch, var(--primary), transparent 80%)' },
          '.cm-searchMatch-selected': { backgroundColor: 'color-mix(in oklch, var(--primary), transparent 50%)' },
        }),
      );

      const state = EditorState.create({ doc: content, extensions });
      const view = new EditorView({ state, parent: containerRef.current });
      viewRef.current = view;

      return () => {
        view.destroy();
        viewRef.current = null;
      };
      // Re-create only when fundamental flags change. `content` syncs via the
      // dedicated effect below to avoid losing undo history.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isDark, readOnly]);

    // Sync external content changes using a minimal prefix/suffix diff so undo
    // history outside the changed region is preserved.
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const currentDoc = view.state.doc.toString();
      if (currentDoc === content) return;

      let prefix = 0;
      const minLen = Math.min(currentDoc.length, content.length);
      while (prefix < minLen && currentDoc.charCodeAt(prefix) === content.charCodeAt(prefix)) {
        prefix++;
      }
      let oldEnd = currentDoc.length;
      let newEnd = content.length;
      while (
        oldEnd > prefix &&
        newEnd > prefix &&
        currentDoc.charCodeAt(oldEnd - 1) === content.charCodeAt(newEnd - 1)
      ) {
        oldEnd--;
        newEnd--;
      }

      isExternalUpdate.current = true;
      view.dispatch({
        changes: { from: prefix, to: oldEnd, insert: content.slice(prefix, newEnd) },
        annotations: Transaction.addToHistory.of(false),
      });
      isExternalUpdate.current = false;
    }, [content]);

    useEffect(() => {
      if (targetLine == null) return;

      const tryScroll = () => {
        const view = viewRef.current;
        if (!view || view.state.doc.length === 0) return false;
        try {
          const lineIndex = Math.max(0, targetLine - 1);
          if (lineIndex >= view.state.doc.lines) return true;
          const line = view.state.doc.line(lineIndex + 1);
          view.dispatch({
            selection: { anchor: line.from, head: line.to },
            scrollIntoView: true,
            effects: EditorView.scrollIntoView(line.from, { y: 'center', yMargin: 100 }),
          });
          setTimeout(() => view.focus(), 50);
        } catch {
          // ignore
        }
        return true;
      };

      if (tryScroll()) return;
      let attempts = 0;
      const timer = setInterval(() => {
        attempts++;
        if (tryScroll() || attempts >= 5) clearInterval(timer);
      }, 100);
      return () => clearInterval(timer);
    }, [targetLine, content]);

    return (
      <div
        ref={containerRef}
        className={cn('h-full overflow-hidden', isDark ? 'bg-[#282c34]' : 'bg-paper')}
      />
    );
  },
);

export default MarkdownEditor;

