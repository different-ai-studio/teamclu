/**
 * ShikiRenderer - Syntax highlighting using Shiki.
 *
 * Provides lazy-loaded, cached Shiki highlighter for diff rendering
 * and chat Markdown code blocks (Notion themes).
 */

import type { BundledLanguage, HighlighterGeneric, ThemeRegistration } from 'shiki';
import {
  NOTION_DARK_THEME_NAME,
  NOTION_LIGHT_THEME_NAME,
  notionDarkTheme,
  notionLightTheme,
} from './notion-shiki-themes';

export { NOTION_DARK_THEME_NAME, NOTION_LIGHT_THEME_NAME };

type AppTheme = 'github-dark' | 'github-light' | typeof NOTION_LIGHT_THEME_NAME | typeof NOTION_DARK_THEME_NAME;

let highlighterPromise: Promise<HighlighterGeneric<BundledLanguage, AppTheme>> | null = null;

/**
 * Get or create a shared Shiki highlighter instance.
 * Lazy loads on first use.
 */
export async function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then(({ createHighlighter }) =>
      createHighlighter({
        themes: [
          'github-dark',
          'github-light',
          notionLightTheme as ThemeRegistration,
          notionDarkTheme as ThemeRegistration,
        ],
        langs: [
          'typescript', 'javascript', 'python', 'json', 'yaml', 'css',
          'html', 'xml', 'sql', 'shell', 'markdown', 'rust', 'go',
          'java', 'c', 'cpp',
        ],
      }),
    ) as Promise<HighlighterGeneric<BundledLanguage, AppTheme>>;
  }
  return highlighterPromise;
}

/**
 * Map common language identifiers to Shiki language identifiers.
 */
export function mapLanguage(lang: string): BundledLanguage {
  const map: Record<string, BundledLanguage> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    yml: 'yaml',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    rs: 'rust',
    md: 'markdown',
    dockerfile: 'shell',
  };
  return (map[lang] || lang) as BundledLanguage;
}

