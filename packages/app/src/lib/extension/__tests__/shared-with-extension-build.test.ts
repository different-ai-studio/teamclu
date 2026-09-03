import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `lib/extension/link-hover` and `lib/extension/link-session` are compiled
 * twice: by this app (which has the `@/` alias) and by `apps/extension`, which
 * aliases them as `@teamclu/extension-link-{hover,session}` and has no `@/` of
 * its own — see apps/extension/tsconfig.json and build.mjs.
 *
 * So those two directories may not use `@/` for anything. It resolves here and
 * fails there, at the extension's own tsc/esbuild step rather than in this
 * suite, which is why the guard lives on this side.
 *
 * `message-cache` is deliberately not listed: nothing in the extension build
 * aliases it, so it is app-only and `@/` is fine there.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHARED = ['link-hover', 'link-session'];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('directories shared with the extension build', () => {
  it('never use the @/ alias, which only this package resolves', () => {
    const offenders: string[] = [];
    for (const dir of SHARED) {
      const root = path.join(HERE, '..', dir);
      for (const file of sourceFiles(root)) {
        const text = fs.readFileSync(file, 'utf8');
        for (const [, spec] of text.matchAll(/['"](@\/[^'"]+)['"]/g)) {
          offenders.push(`${path.relative(root, file)}: ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('actually scanned the shared directories', () => {
    for (const dir of SHARED) {
      expect(sourceFiles(path.join(HERE, '..', dir)).length).toBeGreaterThan(0);
    }
  });
});
