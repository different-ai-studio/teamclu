#!/usr/bin/env node
/**
 * Build the TeamClu feature posters — 1920×1080, English, Editorial Calm.
 *
 *   node posterkit/build-poster.mjs              # all topics
 *   node posterkit/build-poster.mjs sessions     # one topic
 *
 * Copy lives in `posterkit/topics/*.mjs`, layout in `posterkit/layout.mjs`, and
 * the measured drawing primitives in `kits/design.mjs` (shared with videokit).
 * This file only wires them up and reports the layout audit.
 *
 * The audit is not decoration. The first skills poster shipped with a card
 * running two lines past its own bottom edge, and the audit — not a human eye —
 * is what caught it. Anything that overruns, or that had to shrink to fit, is
 * printed; a clean run says so explicitly.
 *
 * Requires ImageMagick (brew install imagemagick).
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesign } from '../kits/design.mjs';
import { renderPoster, W, H } from './layout.mjs';

const KIT = path.dirname(fileURLToPath(import.meta.url));
const TOPICS = path.join(KIT, 'topics');
const OUT = path.join(KIT, 'out');
const MAGICK = process.env.MAGICK || 'magick';

const wanted = process.argv.slice(2);
const available = readdirSync(TOPICS).filter((f) => f.endsWith('.mjs')).map((f) => path.basename(f, '.mjs'));
if (wanted.length === 0) wanted.push(...available);
for (const w of wanted) {
  if (!available.includes(w)) {
    console.error(`unknown topic "${w}". available: ${available.join(', ')}`);
    process.exit(1);
  }
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let failed = 0;
for (const slug of wanted) {
  const topic = (await import(path.join(TOPICS, `${slug}.mjs`))).default;
  const d = createDesign({ width: W, height: H, magick: MAGICK });
  const dest = path.join(OUT, `${slug}-1920x1080.png`);

  try {
    // -strip: ImageMagick stamps date:create / date:modify into every output, so
    // without it two identical runs produce different bytes and `git status` goes
    // dirty on a diff that shows nothing. Same reason as the gallery script.
    d.run([...renderPoster(d, topic), '-strip', dest]);
  } catch (err) {
    const why = (err.stderr || Buffer.alloc(0)).toString().trim() || err.message;
    console.error(`\u2717 ${slug}: ${why}`);
    failed += 1;
    continue;
  }

  const dims = d.run(['identify', '-format', '%wx%h %[depth]-bit', dest]).trim();
  console.log(`built ${path.relative(path.dirname(KIT), dest)}  ${dims}`);
  if (d.notes.length) {
    failed += 1;
    console.log(`  ${d.notes.length} layout note(s):`);
    d.notes.forEach((n) => console.log(`    - ${n}`));
  } else {
    console.log('  layout audit: no overflow, nothing shrunk to fit');
  }
  if (!existsSync(dest)) failed += 1;
}

process.exit(failed ? 1 : 0);
