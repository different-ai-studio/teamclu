#!/usr/bin/env node
/**
 * Shared Editorial Calm drawing primitives for the launch kits.
 *
 * Why this module exists: the coral-accent alignment bugs cost three rounds of
 * fixes, and every one of them was the same mistake — guessing geometry instead
 * of measuring it. `-annotate +X+Y` with unset gravity treats Y as the BASELINE,
 * `-annotate +X` places INK at X + the font's left side bearing, and
 * `-draw rectangle` uses absolute coordinates. Mixing those three without a
 * shared reference produced a coral bar floating above the word it decorated and
 * centred labels that were 10px off. So nothing here estimates:
 *
 *   ink()        measures a string's ink width and side bearing, cached
 *   capOffset()  measures baseline→cap distance per font+pointsize, cached
 *
 * A fixed cap-height ratio does NOT work: Arial Bold measures 0.705–0.75 em
 * across the sizes we use (92/128, 39/54, 22/30, 15/20) because of antialiasing
 * and pixel rounding. Hence the measurement.
 *
 * Consumers:
 *   videokit/build-video.mjs    1920×1080 video stills
 *   posterkit/build-poster.mjs  feature posters
 *
 * Tokens are AGENTS.md §1. They must stay in sync with
 * scripts/build-producthunt-gallery.mjs, which keeps its own copy — that script is
 * stable and referenced by producthunt-kit, so it is deliberately not refactored
 * here.
 */
import { execFileSync } from 'node:child_process';

const DEFAULTS = {
  magick: 'magick',
  // Editorial Calm — AGENTS.md §1
  bg: '#fbfaf7',
  paper: '#ffffff',
  ink: '#1a1a14',
  ink2: '#3d3c34',
  muted: '#75736a',
  faint: '#a8a6a0',
  border: '#e7e2d6',
  coral: '#e85a4a',
  brand: 'TeamClu',
  site: 'teamclu.ai',
  fontBold: '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  fontRegular: '/System/Library/Fonts/Supplemental/Arial.ttf',
};

/**
 * Build a drawing kit bound to one canvas size.
 * `notes` is shared and mutable: helpers push fit/overflow warnings into it so the
 * caller can print an audit instead of silently emitting a broken frame.
 */
export function createDesign({ width, height, magick, fonts, tokens } = {}) {
  const W = width;
  const H = height;
  const T = { ...DEFAULTS, ...(tokens || {}) };
  const F = { bold: fonts?.bold || DEFAULTS.fontBold, regular: fonts?.regular || DEFAULTS.fontRegular };
  const MAGICK = magick || process.env.MAGICK || DEFAULTS.magick;

  // Design coordinates are authored for a 1080-tall frame; scale to the real one.
  const P = (n) => String(Math.round((n * H) / 1080));

  /** Ink stays this far from the right edge; violations are audited. */
  const SAFE_RIGHT = Math.round(W * 0.021);
  const notes = [];
  const trunc = (s) => (s.length > 34 ? `${s.slice(0, 33)}\u2026` : s);

  function run(args) {
    // Two footguns this absorbs:
    //  - a stray null/undefined reaches ImageMagick as the literal string "null",
    //    which it then tries to open as an image file;
    //  - a helper array pushed without `...` arrives here as one element, and
    //    String() would comma-join it into an "unrecognized option" mess.
    const clean = args.flat(Infinity).filter((a) => a !== null && a !== undefined && a !== '').map(String);
    return execFileSync(MAGICK, clean, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).toString();
  }

  // ── measurement ───────────────────────────────────────────────────────────
  const _cap = new Map();
  /** Baseline→cap distance for a font at a size. Reference glyph "H": flat cap. */
  function capOffset(font, pointsize) {
    const key = `${font}|${pointsize}`;
    const hit = _cap.get(key);
    if (hit !== undefined) return hit;
    const baseline = Math.round(pointsize * 1.5);
    const top = Number(run([
      '-size', '2000x400', 'xc:white',
      '-font', font, '-pointsize', P(pointsize), '-fill', 'black',
      '-annotate', `+0+${P(baseline)}`, 'H',
      '-trim', '-format', '%Y', 'info:',
    ]).trim());
    const off = baseline - top;
    _cap.set(key, off);
    return off;
  }

  const capTop = (baseline, pointsize, font = F.bold) => baseline - capOffset(font, pointsize);

  const _ink = new Map();
  /** Ink width and left side bearing, cached. */
  function ink(str, font, pointsize) {
    const key = `${font}|${pointsize}|${str}`;
    const hit = _ink.get(key);
    if (hit) return hit;
    const out = run([
      '-size', '6000x400', 'xc:white',
      '-font', font, '-pointsize', P(pointsize), '-fill', 'black',
      '-annotate', `+0+${P(Math.round(pointsize * 1.5))}`, str,
      '-trim', '-format', '%w %X', 'info:',
    ]).trim().split(/\s+/);
    const val = { w: Number(out[0]), sb: Number(out[1]) };
    _ink.set(key, val);
    return val;
  }

  /** Largest size <= `size` whose ink fits `maxW`. */
  function fitSize(str, font, size, maxW, min = 9) {
    if (!str || !Number.isFinite(maxW)) return size;
    let ps = size;
    while (ps > min && ink(str, font, ps).w > maxW) ps -= 1;
    return ps;
  }

  // ── shapes ────────────────────────────────────────────────────────────────
  const frame = (extra = []) => ['-size', `${W}x${H}`, `xc:${T.bg}`, '-depth', '8', ...extra];

  function roundRect(x, y, w, h, r, stroke, sw, fill) {
    const d = `roundrectangle ${P(x)},${P(y)} ${P(x + w)},${P(y + h)} ${P(r)},${P(r)}`;
    return ['-fill', fill || 'none', '-stroke', stroke, '-strokewidth', P(sw), '-draw', d, '-stroke', 'none'];
  }

  function line(x1, y1, x2, y2, color, sw) {
    return ['-stroke', color, '-strokewidth', P(sw), '-draw', `line ${P(x1)},${P(y1)} ${P(x2)},${P(y2)}`, '-stroke', 'none'];
  }

  /** Filled triangle; `color` optional (omit for a plain fill). */
  function poly(points, color, fill) {
    const pts = points.map(([x, y]) => `${P(x)},${P(y)}`).join(' ');
    const out = ['-fill', fill];
    if (color) out.push('-stroke', color, '-strokewidth', '0');
    else out.push('-stroke', 'none');
    out.push('-draw', `polygon ${pts}`, '-fill', 'none', '-stroke', 'none');
    return out;
  }

  const dot = (cx, cy, r, color) => [
    '-fill', color, '-stroke', 'none', '-draw', `circle ${P(cx)},${P(cy)} ${P(cx + r)},${P(cy)}`,
  ];

  // ── text ──────────────────────────────────────────────────────────────────
  /** Left baseline anchored at x,y. `y` is the BASELINE, not the top. */
  function text(font, size, fill, str, x, y) {
    if (!str) return [];
    return ['-font', font, '-pointsize', P(size), '-fill', fill, '-annotate', `+${P(x)}+${P(y)}`, String(str)];
  }

  /** Ink horizontally centred on `cx`. */
  function textCentered(font, size, fill, str, cx, baseline) {
    if (!str) return [];
    const { w, sb } = ink(str, font, size);
    return ['-font', font, '-pointsize', P(size), '-fill', fill, '-annotate', `+${P(cx - w / 2 - sb)}+${P(baseline)}`, str];
  }

  /** Ink right-aligned to `right`. */
  function textRight(font, size, fill, str, right, baseline) {
    if (!str) return [];
    const { w, sb } = ink(str, font, size);
    return ['-font', font, '-pointsize', P(size), '-fill', fill, '-annotate', `+${P(right - w - sb)}+${P(baseline)}`, str];
  }

  /** Left-aligned, shrinks to fit `maxW`, audits the right margin. */
  function textFit(font, size, fill, str, x, y, maxW, min = 9) {
    if (!str) return [];
    const ps = fitSize(str, font, size, maxW, min);
    const w = ink(str, font, ps).w;
    if (ps < size) notes.push(`shrank "${trunc(str)}" ${size}\u2192${ps}pt to fit ${Math.round(maxW)}px`);
    if (x + w > W - SAFE_RIGHT) notes.push(`RIGHT OVERFLOW "${trunc(str)}" ends at ${Math.round(x + w)}, limit ${W - SAFE_RIGHT}`);
    return text(font, ps, fill, str, x, y);
  }

  /**
   * A pill whose WIDTH IS the measured ink plus padding. Returns { width, height,
   * args } so the caller can lay out the next pill — sizing from a per-character
   * guess is what put "draft the rollback note" outside its own pill.
   */
  function pill(str, font, size, x, y, opts = {}) {
    const { padX = 14, padY = 11, stroke = T.border, fill = T.paper, color = T.ink2, radius = 8, maxW = Infinity } = opts;
    const ps = fitSize(str, font, size, maxW - padX * 2);
    const cap = capOffset(font, ps);
    const w = ink(str, font, ps).w + padX * 2;
    const h = cap + padY * 2;
    if (x + w > W - SAFE_RIGHT) notes.push(`PILL OVERFLOW "${trunc(str)}" ends at ${Math.round(x + w)}`);
    return {
      width: w,
      height: h,
      args: [...roundRect(x, y, w, h, radius, stroke, 1.5, fill), ...text(font, ps, color, str, x + padX, y + padY + cap)],
    };
  }

  /**
   * Greedy word wrap to a measured pixel width. Returns an array of lines, each
   * guaranteed to fit — so callers can lay out a block by counting lines instead
   * of hoping. Monospace-like per-character estimates are what put text outside
   * its own container in the first place.
   */
  function wrap(str, font, size, maxW) {
    const out = [];
    let cur = '';
    for (const word of String(str).split(/\s+/).filter(Boolean)) {
      const next = cur ? `${cur} ${word}` : word;
      if (cur && ink(next, font, size).w > maxW) {
        out.push(cur);
        cur = word;
      } else {
        cur = next;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  // ── brand marks ───────────────────────────────────────────────────────────
  /**
   * The coral accent bar. Two alignments:
   *   align 'cap'    bottom edge on the text's cap line — hangs above the text,
   *                  the rule scripts/build-producthunt-gallery.mjs uses
   *                  (bar 62→98 against a measured cap top of 97)
   *   align 'center' vertically centred on the text's cap span — sits BESIDE
   *                  the text, which is what a marker next to an eyebrow wants
   *
   * Keeps coral to one spot per frame, per AGENTS.md §1.
   */
  function accentBar(baseline, size, { x, height = 56, font = F.bold, align = 'cap' } = {}) {
    const cap = capOffset(font, size);
    const top = align === 'center'
      ? baseline - cap / 2 - height / 2
      : baseline - cap - height;
    return roundRect(x, top, 12, height, 3, T.coral, 0, T.coral);
  }

  const BADGE = 62;
  const BADGE_FONT = 30;
  /**
   * Coral step badge; the digit's ink box is centred, not its layout box (the ink
   * is only ~10px wide at 30pt, so ignoring the side bearing pushed it ~10px
   * right of centre). x/y are defaulted because callers legitimately write
   * `badge(n)` to mean the standard top-left position.
   */
  function badge(n, x = 96, y = 128) {
    const capH = capOffset(F.bold, BADGE_FONT);
    const baseline = y + (BADGE + capH) / 2;
    return [
      ...roundRect(x, y, BADGE, BADGE, 14, T.coral, 0, T.coral),
      ...textCentered(F.bold, BADGE_FONT, T.paper, String(n), x + BADGE / 2, baseline),
    ];
  }

  // Actor discs, per AGENTS.md §4.5 / §5: humans are circles with a green online
  // dot, agents are rounded squares with a coral ring.
  const ACTORS = [
    { letter: 'D', kind: 'human', color: '#4a7fb5' },
    { letter: 'I', kind: 'human', color: '#7a5ea8' },
    { letter: 'M', kind: 'human', color: '#3f8f6a' },
    { letter: 'R', kind: 'agent', color: '#c2703f' },
    { letter: 'Q', kind: 'agent', color: '#a8853a' },
  ];

  function disc(a, x, y, d) {
    const r = d / 2;
    const out = [];
    if (a.kind === 'agent') out.push(...roundRect(x, y, d, d, Math.round(d * 0.26), T.coral, 2, a.color));
    else out.push(dot(x + r, y + r, r, a.color));
    out.push(...textCentered(F.bold, Math.round(d * 0.44), '#ffffff', a.letter, x + r, y + r + d * 0.16));
    if (a.kind === 'human') {
      out.push(['-fill', '#2eb872', '-stroke', '#ffffff', '-strokewidth', '2',
        '-draw', `circle ${P(x + d - d * 0.17)},${P(y + d - d * 0.17)} ${P(x + d - d * 0.04)},${P(y + d - d * 0.17)}`, '-stroke', 'none']);
    }
    return out;
  }

  /** Overlapping actor cluster ending at `right`; actor 0 is leftmost and on top. */
  function cluster(actors, right, y, d = 40, overlap = 12) {
    const total = actors.length * d - (actors.length - 1) * overlap;
    const left = right - total;
    const out = [];
    for (let i = actors.length - 1; i >= 0; i -= 1) out.push(...disc(actors[i], left + i * (d - overlap), y, d));
    return { args: out, left, width: total };
  }

  return {
    W, H, T, F, P, notes, SAFE_RIGHT,
    run, frame, roundRect, line, poly, dot,
    text, textCentered, textRight, textFit, pill, fitSize, ink, capOffset, capTop, wrap,
    accentBar, badge, ACTORS, disc, cluster,
  };
}
