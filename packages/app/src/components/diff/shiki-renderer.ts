/**
 * Syntax highlighting for diff rendering and chat markdown code blocks.
 *
 * PERF-19 — a fine-grained bundle, not `shiki` itself.
 *
 * Importing `shiki` pulls the full bundle: its language map names all ~220
 * grammars, so the bundler emits a chunk for every one of them (~450 chunks,
 * ~10 MB in the app) whether or not any is reachable. The 16 in
 * `LANGUAGE_LOADERS` are the only ones this app has ever asked for.
 *
 * The old list was also loaded eagerly — all 16 grammars parsed the first time
 * anyone opened a chat with a single ``` block. Each is a dynamic import now
 * and loads when a block of that language is first rendered.
 *
 * `shiki/core` + `shiki/engine/oniguruma` are the same code paths
 * `shiki/bundle/full` uses; only the language and theme maps differ.
 */

import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import {
  NOTION_DARK_THEME_NAME,
  NOTION_LIGHT_THEME_NAME,
  notionDarkTheme,
  notionLightTheme,
} from './notion-shiki-themes';

export { NOTION_DARK_THEME_NAME, NOTION_LIGHT_THEME_NAME };

export type AppTheme =
  | 'github-dark'
  | 'github-light'
  | typeof NOTION_LIGHT_THEME_NAME
  | typeof NOTION_DARK_THEME_NAME;

/**
 * The grammars this app ships. Adding one here is the whole change — it costs
 * a chunk that is fetched only when a code block of that language renders.
 */
const LANGUAGE_LOADERS = {
  typescript: () => import('@shikijs/langs/typescript'),
  javascript: () => import('@shikijs/langs/javascript'),
  python: () => import('@shikijs/langs/python'),
  json: () => import('@shikijs/langs/json'),
  yaml: () => import('@shikijs/langs/yaml'),
  css: () => import('@shikijs/langs/css'),
  html: () => import('@shikijs/langs/html'),
  xml: () => import('@shikijs/langs/xml'),
  sql: () => import('@shikijs/langs/sql'),
  shell: () => import('@shikijs/langs/shellscript'),
  markdown: () => import('@shikijs/langs/markdown'),
  rust: () => import('@shikijs/langs/rust'),
  go: () => import('@shikijs/langs/go'),
  java: () => import('@shikijs/langs/java'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
} as const;

export type SupportedLanguage = keyof typeof LANGUAGE_LOADERS;

/** Aliases a fence can carry for one of the languages above. */
const LANGUAGE_ALIASES: Record<string, SupportedLanguage> = {
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

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLanguages = new Map<SupportedLanguage, Promise<void>>();

/**
 * Resolve a fence's language tag to a grammar this app carries, or null when
 * it carries none — the caller renders unhighlighted rather than guessing.
 */
export function mapLanguage(lang: string): SupportedLanguage | null {
  const normalized = lang.trim().toLowerCase();
  const alias = LANGUAGE_ALIASES[normalized];
  if (alias) return alias;
  return normalized in LANGUAGE_LOADERS ? (normalized as SupportedLanguage) : null;
}

/** Get or create the shared highlighter. Themes only; grammars arrive later. */
export async function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [
        import('@shikijs/themes/github-dark'),
        import('@shikijs/themes/github-light'),
        notionLightTheme,
        notionDarkTheme,
      ],
      langs: [],
      engine: createOnigurumaEngine(import('shiki/wasm')),
    });
  }
  return highlighterPromise;
}

async function ensureLanguage(
  highlighter: HighlighterCore,
  lang: SupportedLanguage,
): Promise<void> {
  let pending = loadedLanguages.get(lang);
  if (!pending) {
    pending = LANGUAGE_LOADERS[lang]().then(async (mod) => {
      await highlighter.loadLanguage(mod.default);
    });
    loadedLanguages.set(lang, pending);
  }
  await pending;
}

/**
 * Highlight `code`, or return null when the language is one this app does not
 * carry a grammar for. Loads that grammar on first use.
 */
export async function highlightToHtml(
  code: string,
  language: string,
  theme: AppTheme,
): Promise<string | null> {
  const lang = mapLanguage(language);
  if (!lang) return null;
  const highlighter = await getHighlighter();
  await ensureLanguage(highlighter, lang);
  return highlighter.codeToHtml(code, { lang, theme });
}
