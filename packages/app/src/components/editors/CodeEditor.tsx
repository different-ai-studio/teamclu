/**
 * CodeEditor - Lightweight code editor using CodeMirror 6.
 *
 * Features:
 * - Syntax highlighting for multiple programming languages
 * - Basic editing operations
 * - Line numbers display
 * - Content modification tracking
 * - Read-first, edit-secondary experience
 * - On-demand language package loading
 */

import { useEffect, useRef } from 'react';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { EditorState, Transaction, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, toggleComment } from '@codemirror/commands';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { search, searchKeymap } from '@codemirror/search';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter, indentOnInput } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { cn } from '@/lib/utils';
import type { EditorProps } from './types';
import { computeMinimalChange, getLanguageFromFilename } from './utils';
import {
  gitGutterExtension,
  gitGutterAutoUpdate,
  computeLineChanges,
  updateGitGutter,
} from './git-gutter';

/**
 * Dynamically load a CodeMirror language extension based on language identifier.
 * Returns null for unsupported languages (falls back to plain text).
 */
async function loadLanguageExtension(language: string): Promise<Extension | null> {
  try {
    switch (language) {
      case 'typescript':
      case 'javascript': {
        const { javascript } = await import('@codemirror/lang-javascript');
        return javascript({ typescript: language === 'typescript', jsx: true });
      }
      case 'python': {
        const { python } = await import('@codemirror/lang-python');
        return python();
      }
      case 'json': {
        const { json } = await import('@codemirror/lang-json');
        return json();
      }
      case 'yaml': {
        const { yaml } = await import('@codemirror/lang-yaml');
        return yaml();
      }
      case 'css':
      case 'scss':
      case 'less': {
        const { css } = await import('@codemirror/lang-css');
        return css();
      }
      case 'html': {
        const { html } = await import('@codemirror/lang-html');
        return html();
      }
      case 'xml': {
        const { xml } = await import('@codemirror/lang-xml');
        return xml();
      }
      case 'sql': {
        const { sql } = await import('@codemirror/lang-sql');
        return sql();
      }
      case 'rust': {
        const { rust } = await import('@codemirror/lang-rust');
        return rust();
      }
      case 'markdown': {
        // For markdown in code editor, use basic highlighting
        return null;
      }
      default:
        return null;
    }
  } catch {
    console.warn(`Failed to load language extension for: ${language}`);
    return null;
  }
}

export function CodeEditor({
  content,
  filename,
  onChange,
  readOnly = false,
  isDark = false,
  originalContent,
  targetLine,
}: EditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Track whether we're programmatically updating content
  const isExternalUpdate = useRef(false);

  // Store original content ref for git gutter
  const originalContentRef = useRef<string | null>(originalContent ?? null);
  originalContentRef.current = originalContent ?? null;

  const language = getLanguageFromFilename(filename);

  // Initialize editor
  useEffect(() => {
    if (!containerRef.current) return;

    let destroyed = false;

    const initEditor = async () => {
      const langExtension = await loadLanguageExtension(language);
      if (destroyed) return;

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
          { key: 'Mod-/', run: toggleComment },
        ]),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !isExternalUpdate.current) {
            const newContent = update.state.doc.toString();
            onChangeRef.current?.(newContent);
          }
        }),
      ];

      if (isDark) {
        extensions.push(oneDark);
      }

      if (langExtension) {
        extensions.push(langExtension);
      }

      if (readOnly) {
        extensions.push(EditorState.readOnly.of(true));
      }

      // Git gutter decorations – always installed so late-arriving
      // originalContent (async from git HEAD) still works.
      extensions.push(
        gitGutterExtension(),
        gitGutterAutoUpdate(() => originalContentRef.current),
      );

      // Custom theme for padding, font, and search panel
      extensions.push(
        EditorView.theme({
          '&': {
            height: '100%',
            fontSize: '13px',
          },
          '.cm-content': {
            fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, Monaco, 'Courier New', monospace",
            padding: '8px 0',
          },
          '.cm-scroller': {
            overflow: 'auto',
          },
          '.cm-gutters': {
            borderRight: 'none',
          },
          /* ---- Search panel ---- */
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
          '.cm-search input[type="text"], .cm-search input[type="checkbox"]': {
            margin: '0',
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
            cursor: 'pointer',
          },
          '.cm-search button:hover': {
            backgroundColor: 'var(--muted)',
          },
          '.cm-search button:active': {
            backgroundColor: 'var(--border)',
          },
          '.cm-search label': {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            fontSize: '12px',
            color: 'var(--muted-foreground)',
            cursor: 'pointer',
          },
          '.cm-search label:hover': {
            color: 'var(--foreground)',
          },
          '.cm-search input[type="checkbox"]': {
            width: '14px',
            height: '14px',
            borderRadius: '3px',
            accentColor: 'var(--primary)',
            cursor: 'pointer',
          },
          '.cm-search .cm-button[name="close"]': {
            padding: '0 4px',
            border: 'none',
            backgroundColor: 'transparent',
            color: 'var(--muted-foreground)',
            fontSize: '16px',
          },
          '.cm-search .cm-button[name="close"]:hover': {
            color: 'var(--foreground)',
            backgroundColor: 'transparent',
          },
          /* Search match highlights */
          '.cm-searchMatch': {
            backgroundColor: 'color-mix(in oklch, var(--primary), transparent 80%)',
          },
          '.cm-searchMatch-selected': {
            backgroundColor: 'color-mix(in oklch, var(--primary), transparent 50%)',
          },
        }),
      );

      const state = EditorState.create({
        doc: content,
        extensions,
      });

      const view = new EditorView({
        state,
        parent: containerRef.current!,
      });

      viewRef.current = view;
    };

    initEditor();

    return () => {
      destroyed = true;
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
    // Only re-create editor when language or theme changes fundamentally
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, isDark, readOnly]);

  // Sync content when prop changes (external updates)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    // A minimal diff, not a wholesale replace: see computeMinimalChange for
    // why that is what keeps undo history across an external sync.
    const change = computeMinimalChange(view.state.doc.toString(), content);
    if (!change) return;

    isExternalUpdate.current = true;
    view.dispatch({
      changes: change,
      annotations: Transaction.addToHistory.of(false),
    });
    isExternalUpdate.current = false;
  }, [content]);

  // Update git gutter when originalContent changes
  useEffect(() => {
    const view = viewRef.current;
    if (!view || originalContent === null || originalContent === undefined) return;

    const current = view.state.doc.toString();
    const changes = computeLineChanges(originalContent, current);
    updateGitGutter(view, changes);
  }, [originalContent]);

  // Scroll to target line when specified
  useEffect(() => {
    if (targetLine == null) return;

    // Retry until the editor is ready and has content, up to 500ms
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
          effects: EditorView.scrollIntoView(line.from, {
            y: 'center',
            yMargin: 100,
          }),
        });
        setTimeout(() => view.focus(), 50);
      } catch {
        // Silently ignore scroll errors
      }
      return true;
    };

    if (tryScroll()) return;

    // Poll until editor and content are ready
    let attempts = 0;
    const timer = setInterval(() => {
      attempts++;
      if (tryScroll() || attempts >= 5) {
        clearInterval(timer);
      }
    }, 100);

    return () => clearInterval(timer);
  }, [targetLine, content]);

  return (
    <div
      ref={containerRef}
      className={cn('h-full overflow-hidden', isDark ? 'bg-[#282c34]' : 'bg-white')}
    />
  );
}

export default CodeEditor;
