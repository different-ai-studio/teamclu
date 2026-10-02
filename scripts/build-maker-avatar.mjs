#!/usr/bin/env node
/**
 * Build the PH maker-avatar review sheet and the two upload-ready PNGs.
 *
 *   node scripts/build-maker-avatar.mjs
 *
 * Why the sheet is built in Chrome and not ImageMagick: every attempt to
 * composite downsampled avatars onto a canvas in ImageMagick produced clipped
 * quarter-discs at 32px and 64px, because the small images got anchored to a
 * canvas corner and the disc was cut. A browser is also the honest renderer
 * here — this is exactly how PH will display the file, at exactly these CSS
 * pixel sizes, with its own antialiasing.
 *
 * Why nothing is rendered at a small size directly: Chrome's --window-size has
 * a floor (roughly 500px); below that it returns an all-black frame instead of
 * rendering. The first version of this script asked for 32x32, got a black
 * square, and the "check" passed on an empty image. So: render the SVG once at
 * full size, downsample with Lanczos, and let the browser lay it out.
 *
 * Requires: Chrome, ImageMagick.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'producthunt-kit', 'avatar');
const SVG = path.join(DIR, 'maker-avatar.svg');
const TMP = path.join(DIR, '.tmp');

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MAGICK = process.env.MAGICK || 'magick';

/** Upload sizes. PH takes either; 1024 is the safest master. */
const SHIP = [1024, 256];

/** Sizes a viewer actually sees. 32 is what PH renders in comment threads. */
const CHECK = [32, 40, 64, 128];

const MASTER = 1024;

/** Warm white, same as the app icon body. */
const PAPER = '#faf7f0';

function run(cmd, args) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function renderSvg(size, dest) {
  run(CHROME, [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    `--screenshot=${dest}`,
    `--window-size=${size},${size}`,
    '--force-device-scale-factor=1',
    `file://${SVG}`,
  ]);
}

function pngSize(file) {
  const out = run(MAGICK, ['identify', '-format', '%w %h', file]).trim();
  const [w, h] = out.split(/\s+/).map(Number);
  return { w, h };
}

/** Fail loudly on a blank render — the failure mode that hides in plain sight. */
function assertNotBlank(file, label) {
  // Two separate identify calls on purpose: ImageMagick honours only the last
  // -format on the command line, so `-format '%[fx:mean] %k'` prints just the
  // colour count and the mean comes back undefined — which is what made this
  // check read every render as blank.
  const mean = Number(
    run(MAGICK, [file, '-colorspace', 'Gray', '-format', '%[fx:mean]', 'info:']).trim(),
  );
  const colors = Number(run(MAGICK, [file, '-format', '%k', 'info:']).trim());
  if (!Number.isFinite(mean) || mean > 0.99 || colors < 4) {
    console.error(
      `✗ ${label} looks blank (mean=${mean}, colors=${colors}) — refusing to ship it`,
    );
    process.exit(1);
  }
  return { mean: Math.round(mean * 100), colors };
}

function main() {
  if (!existsSync(SVG)) {
    console.error(`✗ missing ${path.relative(ROOT, SVG)}`);
    process.exit(1);
  }
  if (!existsSync(CHROME)) {
    console.error(`✗ Chrome not found at ${CHROME}. Set CHROME=/path/to/chrome`);
    process.exit(1);
  }

  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  // One master render, downsampled for everything else.
  const master = path.join(TMP, 'master.png');
  renderSvg(MASTER, master);
  const m = pngSize(master);
  if (m.w !== MASTER || m.h !== MASTER) {
    console.error(`✗ master rendered ${m.w}×${m.h}, expected ${MASTER}×${MASTER}`);
    process.exit(1);
  }
  const masterStats = assertNotBlank(master, 'master render');

  for (const size of SHIP) {
    const out = path.join(DIR, `maker-avatar-${size}.png`);
    // Chrome's --screenshot always paints an opaque page background, so the
    // SVG's own transparent corners come out white rather than transparent.
    // Flatten onto the brand paper instead: PH crops to a circle so the corners
    // are never seen, but a white #ffffff square next to a #faf7f0 circle reads
    // as a faint halo on any non-white surface.
    run(MAGICK, [
      master,
      '-resize', `${size}x${size}`,
      '-background', PAPER,
      '-alpha', 'remove',
      '-alpha', 'off',
      '-strip',
      out,
    ]);
    const s = pngSize(out);
    assertNotBlank(out, `maker-avatar-${size}.png`);
    console.log(`✓ maker-avatar-${size}.png  ${s.w}×${s.h}`);
  }

  // Downsamples for the sheet.
  for (const size of CHECK) {
    const out = path.join(TMP, `at-${size}.png`);
    run(MAGICK, [master, '-filter', 'Lanczos', '-resize', `${size}x${size}`, out]);
    const s = pngSize(out);
    if (s.w !== size || s.h !== size) {
      console.error(`✗ downsample is ${s.w}×${s.h}, expected ${size}×${size}`);
      process.exit(1);
    }
  }

  // The sheet: a plain HTML page, screenshotted by Chrome. Background is a
  // neutral grey-brown so any part of the mark escaping the circular crop is
  // immediately visible as a stray shape.
  const cells = CHECK.map(
    (s) => `
      <figure>
        <img src="at-${s}.png" width="${s}" height="${s}" alt="" />
        <figcaption>${s}px</figcaption>
      </figure>`,
  ).join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  :root { color-scheme: light; }
  body {
    margin: 0; padding: 34px 30px 26px;
    background: #d9d4c9;
    font: 13px/1.4 "Helvetica Neue", Arial, sans-serif;
    color: #3d3c34;
  }
  h1 { font-size: 15px; margin: 0 0 4px; color: #1a1a14; }
  p  { margin: 0 0 22px; color: #75736a; max-width: 60ch; }
  .row { display: flex; align-items: flex-end; gap: 40px; }
  figure { margin: 0; text-align: center; }
  img  { display: block; image-rendering: auto; }
  figcaption { margin-top: 12px; color: #75736a; font-size: 12px; }
</style></head>
<body>
  <h1>TeamClu maker avatar — legibility at PH display sizes</h1>
  <p>Product Hunt masks every avatar to a circle and renders it at 32–40px in
     comment threads. Each mark below is a real downsample of the 1024 master, so
     this is the actual output, not a mock-up.</p>
  <div class="row">${cells}</div>
</body></html>`;

  const htmlFile = path.join(TMP, 'sheet.html');
  writeFileSync(htmlFile, html, 'utf8');
  const sheet = path.join(DIR, 'maker-avatar-size-check.png');
  run(CHROME, [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    `--screenshot=${sheet}`,
    '--window-size=760,300',
    '--force-device-scale-factor=1',
    '--default-background-color=00000000',
    `file://${htmlFile}`,
  ]);
  assertNotBlank(sheet, 'size-check sheet');
  const ss = pngSize(sheet);
  console.log(`✓ maker-avatar-size-check.png  ${ss.w}×${ss.h}  (${CHECK.join(' | ')} px)`);
  // Ink coverage, not mean luminance. A mean is the wrong instrument here: this
  // avatar is mostly warm-white paper by design, so its mean sits around 83%
  // and always will — the check that "mean must be under 82%" only ever measured
  // how much background the artwork has, never whether the mark is visible.
  //
  // What actually matters is that enough of the disc is covered in ink and
  // coral. Under ~12% coverage the mark greys out to a smudge at 32px.
  // -negate is load-bearing. `-threshold` yields a pure black-and-white image,
  // so %[fx:mean] over it is the fraction of *white* pixels — thresholding at
  // 45% puts the warm-white paper at white and the ink at black, so the mean
  // comes back as 85% for a mark whose ink coverage is 15%. Negating first
  // makes the mean mean ink.
  const ink = Number(
    run(MAGICK, [
      path.join(DIR, 'maker-avatar-256.png'),
      '-colorspace', 'Gray',
      '-threshold', '45%',
      '-negate',
      '-format', '%[fx:mean]',
      'info:',
    ]).trim(),
  );
  const inkPct = Math.round(ink * 100);
  if (!Number.isFinite(inkPct) || inkPct < 12) {
    console.error(
      `✗ ink coverage ${inkPct}% — the mark will not survive 32px (needs ≥12%)`,
    );
    process.exit(1);
  }
  console.log(`✓ ink coverage ${inkPct}% of the disc (fails below 12%)`);
  console.log(`✓ master render: ${masterStats.colors} colours, mean ${masterStats.mean}%`);

  rmSync(TMP, { recursive: true, force: true });
  console.log(`\nIn ${path.relative(ROOT, DIR)}/`);
  console.log('Upload maker-avatar-1024.png to Product Hunt.');
  console.log('The size-check sheet is for review — do not upload it.');
  void readFileSync;
}

main();
