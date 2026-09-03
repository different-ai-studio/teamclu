import { describe, expect, it } from 'vitest';
import {
  highlightToHtml,
  mapLanguage,
  NOTION_DARK_THEME_NAME,
  NOTION_LIGHT_THEME_NAME,
} from '../shiki-renderer';

describe('mapLanguage', () => {
  it('resolves aliases', () => {
    expect(mapLanguage('ts')).toBe('typescript');
    expect(mapLanguage('tsx')).toBe('typescript');
    expect(mapLanguage('bash')).toBe('shell');
    expect(mapLanguage('rs')).toBe('rust');
    expect(mapLanguage('yml')).toBe('yaml');
  });

  it('passes through a carried language', () => {
    expect(mapLanguage('python')).toBe('python');
    expect(mapLanguage('CPP')).toBe('cpp');
    expect(mapLanguage('  json  ')).toBe('json');
  });

  it('returns null for a language this app carries no grammar for', () => {
    // Previously this cast the tag to BundledLanguage and let codeToHtml
    // throw. The caller has to be able to tell "not carried" from "failed".
    expect(mapLanguage('brainfuck')).toBeNull();
    expect(mapLanguage('')).toBeNull();
    expect(mapLanguage('text')).toBeNull();
  });
});

describe('highlightToHtml', () => {
  it('highlights with a bundled theme', async () => {
    const html = await highlightToHtml('const a = 1', 'ts', 'github-dark');
    expect(html).toContain('<pre');
    expect(html).toContain('const');
  }, 30_000);

  it('highlights with both Notion themes', async () => {
    for (const theme of [NOTION_LIGHT_THEME_NAME, NOTION_DARK_THEME_NAME] as const) {
      const html = await highlightToHtml('SELECT 1', 'sql', theme);
      expect(html).toContain('<pre');
    }
  }, 30_000);

  it('loads a second grammar on demand', async () => {
    const html = await highlightToHtml('fn main() {}', 'rust', 'github-light');
    expect(html).toContain('<pre');
    expect(html).toContain('main');
  }, 30_000);

  it('returns null rather than throwing for an unknown language', async () => {
    await expect(highlightToHtml('???', 'brainfuck', 'github-dark')).resolves.toBeNull();
  });
});
