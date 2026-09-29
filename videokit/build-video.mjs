#!/usr/bin/env node
/**
 * Build the TeamClu launch video.
 *
 *   node videokit/build-video.mjs
 *
 * The narrative is a LOOP, not a feature list:
 *
 *     ASSIGN → BUILD → REVIEW → COMPOUND ↺
 *
 * Most AI tooling starts at BUILD and stops there. TeamClu is the claim that
 * the loop closes — the result of a round becomes a team asset, so the next
 * round starts faster. Source: docs/features/ (04 §0 team assets, 06 §0/§4/§6
 * skills as a versioned team object, 03 §3.2 agent replies as notes, 10 §1–2
 * the diff reviewer is agent-first, 07 §2 capability lives in the kernel).
 *
 * Design rules, both deliberate:
 *
 *   1. NO CAMERA MOTION. No zoompan, no Ken Burns, no pan, no cross-dissolve.
 *      Frames are static and cut hard. An earlier revision used Ken Burns and
 *      it read as a slideshow with a nervous camera.
 *
 *   2. NO FABRICATED UI. Only two real product screenshots appear, for the two
 *      beats where a screenshot is actual evidence: the group session (assign)
 *      and the skill version history (compound). The BUILD and REVIEW beats
 *      have no screenshot in the repo — there is no capture of the diff
 *      reviewer anywhere — so they are rendered as labelled spec diagrams
 *      rather than as fake product shots. producthunt-kit/README.md §5 forbids
 *      mockups posing as product screenshots, and that rule holds here too.
 *
 * Requires: ImageMagick (brew install imagemagick) and ffmpeg with libx264.
 *
 * Env overrides:
 *   MAGICK / FFMPEG / FFPROBE   command names
 *   VIDEO_FPS                   frames per second (default 30)
 *   VIDEO_SCALE                 "1080" or "720" (default 1080)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(KIT, '..');
const GALLERY = path.join(ROOT, 'producthunt-kit', 'screenshots');
const TMP = path.join(KIT, '.tmp');
const STILLS = path.join(TMP, 'stills');
const OUT = path.join(KIT, 'out');

const MAGICK = process.env.MAGICK || 'magick';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const FPS = Number(process.env.VIDEO_FPS || 30);
const HEIGHT = Number(process.env.VIDEO_SCALE || 1080) === 720 ? 720 : 1080;
const WIDTH = Math.round((HEIGHT * 16) / 9);

const FONT_BOLD =
  process.env.VIDEO_FONT_BOLD || '/System/Library/Fonts/Supplemental/Arial Bold.ttf';
const FONT_REGULAR =
  process.env.VIDEO_FONT_REGULAR || '/System/Library/Fonts/Supplemental/Arial.ttf';

// Editorial Calm tokens, AGENTS.md §1. Same values the gallery and the app use.
const BG = '#fbfaf7';
const PAPER = '#ffffff';
const INK = '#1a1a14';
const INK2 = '#3d3c34';
const MUTED = '#75736a';
const FAINT = '#a8a6a0';
const BORDER = '#e7e2d6';
const CORAL = '#e85a4a';

const BRAND = 'TeamClu';
const SITE = 'teamclu.ai';

// ── Canvas helpers ─────────────────────────────────────────────────────────
// `u` scales a 1080-height design coordinate to the real frame.
const u = (v) => Math.round((v * HEIGHT) / 1080);
const P = (n) => String(Math.round((n * HEIGHT) / 1080));

function run(cmd, args) {
  // Two footguns this absorbs:
  //  - a stray null/undefined reaches ImageMagick as the literal string "null",
  //    which it then tries to open as an image file;
  //  - a helper array pushed without `...` arrives here as one element, and
  //    String() would comma-join it into an "unrecognized option" mess.
  const clean = args
    .flat(Infinity)
    .filter((a) => a !== null && a !== undefined && a !== '')
    .map(String);
  return execFileSync(cmd, clean, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).toString();
}

function frame(extra = []) {
  return ['-size', `${WIDTH}x${HEIGHT}`, `xc:${BG}`, '-depth', '8', ...extra];
}

/** Text drawn at a 1080-height coordinate, left baseline anchored at x,y. */
function text(font, size, fill, str, x, y) {
  if (!str) return [];
  return ['-font', font, '-pointsize', P(size), '-fill', fill, '-annotate', `+${P(x)}+${P(y)}`, String(str)];
}

function roundRect(x, y, w, h, r, stroke, sw, fill) {
  const d = `roundrectangle ${P(x)},${P(y)} ${P(x + w)},${P(y + h)} ${P(r)},${P(r)}`;
  return ['-fill', fill || 'none', '-stroke', stroke, '-strokewidth', P(sw), '-draw', d, '-stroke', 'none'];
}

function line(x1, y1, x2, y2, color, sw) {
  return ['-stroke', color, '-strokewidth', P(sw), '-draw', `line ${P(x1)},${P(y1)} ${P(x2)},${P(y2)}`, '-stroke', 'none'];
}

/** Filled triangle. `color` is optional — omit it for a plain fill. */
function poly(points, color, fill) {
  const pts = points.map(([x, y]) => `${P(x)},${P(y)}`).join(' ');
  const out = ['-fill', fill];
  if (color) out.push('-stroke', color, '-strokewidth', '0');
  else out.push('-stroke', 'none');
  out.push('-draw', `polygon ${pts}`, '-fill', 'none', '-stroke', 'none');
  return out;
}

/**
 * Distance from the baseline up to the cap line, MEASURED per font+pointsize
 * and cached.
 *
 * Why measured and not a ratio: `-annotate +X+Y` with unset gravity treats Y as
 * the baseline, so anything aligned to a letterform must measure up from there.
 * And a constant ratio does not work — Arial Bold's cap height measures
 * 0.705–0.75 em across the sizes used here (92/128, 39/54, 22/30, 15/20), because
 * of antialiasing and pixel rounding. A fixed 0.742 put the coral bars 2–3px off
 * the cap line and the bars 10px off to the right of the word they decorate.
 *
 * Reference glyph is "H": flat cap, so no round overshoot like "C" or "O".
 */
const _cap = new Map();
function capOffset(font, pointsize) {
  const key = `${font}|${pointsize}`;
  const hit = _cap.get(key);
  if (hit !== undefined) return hit;
  const baseline = Math.round(pointsize * 1.5);
  const out = run(MAGICK, [
    '-size', '2000x400', 'xc:white',
    '-font', font, '-pointsize', P(pointsize), '-fill', 'black',
    '-annotate', `+0+${P(baseline)}`, 'H',
    '-trim', '-format', '%Y', 'info:',
  ]).trim();
  const off = baseline - Number(out);
  _cap.set(key, off);
  return off;
}

const capTop = (baseline, pointsize, font = FONT_BOLD) =>
  baseline - capOffset(font, pointsize);

/** Left margin for the accent-bar cards: the bar hangs left of the text. */
const ACCENT_X = 224;
const TEXT_X = 254;

const _ink = new Map();
/**
 * Ink width and left side bearing for a string, measured with ImageMagick and
 * cached. `-annotate +X+Y` places INK at X + sideBearing, so centring has to
 * subtract the bearing — guessing from character count put every centred label
 * a few pixels off.
 */
function ink(str, font, pointsize) {
  const key = `${font}|${pointsize}|${str}`;
  const hit = _ink.get(key);
  if (hit) return hit;
  const out = run(MAGICK, [
    '-size', '6000x400', 'xc:white',
    '-font', font, '-pointsize', P(pointsize), '-fill', 'black',
    '-annotate', `+0+${P(Math.round(pointsize * 1.5))}`, str,
    '-trim', '-format', '%w %X', 'info:',
  ]).trim().split(/\s+/);
  const val = { w: Number(out[0]), sb: Number(out[1]) };
  _ink.set(key, val);
  return val;
}

/** Draw `str` with its ink horizontally centred on `cx`, baseline at `baseline`. */
function textCentered(font, pointsize, fill, str, cx, baseline) {
  if (!str) return [];
  const { w, sb } = ink(str, font, pointsize);
  return [
    '-font', font, '-pointsize', P(pointsize), '-fill', fill,
    '-annotate', `+${P(cx - w / 2 - sb)}+${P(baseline)}`, str,
  ];
}

/**
 * The coral accent bar. Its BOTTOM edge lands on the headline's cap-top line —
 * the same rule scripts/build-producthunt-gallery.mjs uses (bar 62→98 against a
 * measured cap top of 97). Keeps coral to one spot per frame, per AGENTS.md §1.
 */
function accentBar(baseline, pointsize, { x = ACCENT_X, height = 56 } = {}) {
  return roundRect(x, capTop(baseline, pointsize) - height, 12, height, 3, CORAL, 0, CORAL);
}

/**
 * Coral step badge. The digit's INK BOX is centred in the square, not its
 * layout box — the digit used to sit ~10px right of centre because the
 * side bearing was ignored and the ink is only 10px wide at 30pt.
 */
const BADGE = 62;
const BADGE_FONT = 30;
function badge(n, x = 96, y = 128) {
  const capH = capOffset(FONT_BOLD, BADGE_FONT);
  // centre the digit's ink span (capTop..baseline) on the square's centre
  const baseline = y + (BADGE + capH) / 2;
  return [
    ...roundRect(x, y, BADGE, BADGE, 14, CORAL, 0, CORAL),
    ...textCentered(FONT_BOLD, BADGE_FONT, PAPER, String(n), x + BADGE / 2, baseline),
  ];
}

// ── The loop chain ─────────────────────────────────────────────────────────
const NODES = [
  { key: 'assign', label: 'ASSIGN' },
  { key: 'build', label: 'BUILD' },
  { key: 'review', label: 'REVIEW' },
  { key: 'compound', label: 'COMPOUND' },
];

const NODE_W = 340;
const NODE_H = 152;
const NODE_GAP = 92;
const CHAIN_Y = 452;

function chainLayout() {
  const total = NODES.length * NODE_W + (NODES.length - 1) * NODE_GAP;
  const start = (WIDTH - total) / 2;
  return NODES.map((n, i) => ({ ...n, x: start + i * (NODE_W + NODE_GAP), i }));
}

function drawChain(activeIndex, opts = {}) {
  const box = chainLayout();
  const midY = CHAIN_Y + NODE_H / 2;
  const parts = [];

  box.forEach((n, i) => {
    const active = i === activeIndex;
    const reached = activeIndex < 0 || i <= activeIndex;
    const stroke = active ? CORAL : reached ? BORDER : BORDER;
    const sw = active ? 3 : 1.5;
    const labelFill = active ? INK : reached ? INK2 : FAINT;
    parts.push(...roundRect(n.x, CHAIN_Y, NODE_W, NODE_H, 16, stroke, sw, PAPER));
    const cx = n.x + NODE_W / 2;
    parts.push(...textCentered(FONT_BOLD, 30, labelFill, n.label, cx, CHAIN_Y + 66));
    parts.push(...textCentered(FONT_REGULAR, 20, active ? MUTED : FAINT, opts.captions?.[i] || '', cx, CHAIN_Y + 108));
    if (active) {
      // coral dot: the second and last use of coral in the frame
      parts.push(...['-fill', CORAL, '-draw', `circle ${P(cx)},${P(CHAIN_Y + NODE_H - 26)} ${P(cx + 5)},${P(CHAIN_Y + NODE_H - 26)}`]);
    }
    if (i < NODES.length - 1) {
      const x1 = n.x + NODE_W + 18;
      const x2 = n.x + NODE_W + NODE_GAP - 18;
      const done = activeIndex < 0 || i < activeIndex;
      parts.push(...line(x1, midY, x2 - 9, midY, done ? FAINT : BORDER, 2));
      parts.push(...poly([[x2, midY], [x2 - 11, midY - 7], [x2 - 11, midY + 7]], null, done ? FAINT : BORDER));
    }
  });

  if (opts.loop !== false) {
    // return path: node 4 bottom → back to node 1 bottom
    const x0 = box[0].x + NODE_W / 2;
    const x3 = box[3].x + NODE_W / 2;
    const yTop = CHAIN_Y + NODE_H;
    const yBot = CHAIN_Y + NODE_H + 116;
    parts.push(...line(x3, yTop, x3, yBot, BORDER, 2));
    parts.push(...line(x3, yBot, x0, yBot, BORDER, 2));
    parts.push(...line(x0, yBot, x0, yTop + 12, BORDER, 2));
    parts.push(...poly([[x0, yTop], [x0 - 7, yTop + 12], [x0 + 7, yTop + 12]], null, BORDER));
    if (opts.loopLabel) {
      parts.push(...textCentered(FONT_REGULAR, 24, MUTED, opts.loopLabel, WIDTH / 2, yBot - 18));
    }
  }
  return parts;
}

// ── Scenes ─────────────────────────────────────────────────────────────────
/**
 * dur is in seconds and snapped to a whole frame so hard cuts never drift.
 * `onScreen` is the caption line; it becomes the .srt cue verbatim.
 */
const SCENES = [
  {
    kind: 'title', slug: '00-title', dur: 5,
    onScreen: 'TeamClu \u2014 the loop your team\u2019s AI work actually runs on.',
  },
  {
    kind: 'chain', slug: '01-loop', dur: 7, active: -1,
    title: 'Most AI tooling starts at build.',
    sub: 'TeamClu is the claim that the loop closes.',
    loopLabel: 'and round again',
    onScreen: 'Most AI tooling starts at build and stops there. TeamClu is the claim that the loop closes.',
  },
  {
    kind: 'shot', slug: '02-assign', dur: 13, step: 1, label: 'ASSIGN',
    src: 'ph-4-group-session-1270x760.png',
    onScreen: 'One session. Teammates and agents in the same context \u2014 @mention an agent and it answers as a participant.',
  },
  {
    kind: 'chain', slug: '03-build', dur: 9, active: 1,
    eyebrow: [2, 'BUILD'],
    title: 'The agent runs on your machine.',
    sub: 'You keep your code, your context and your keys. Only the assets are shared.',
    onScreen: 'The agent runs on your machine. Only the assets are shared.',
  },
  {
    kind: 'anatomy', slug: '04-review', dur: 15, step: 3, label: 'REVIEW',
    onScreen: 'An agent does not talk in bubbles. It answers in notes \u2014 and the diff reviewer is built the same way.',
  },
  {
    kind: 'shot', slug: '05-compound', dur: 15, step: 4, label: 'COMPOUND',
    src: 'ph-2-team-skills-1270x760.png',
    onScreen: 'The result becomes a team asset, not a dotfile. Publish once with a changelog and every teammate\u2019s agent follows it.',
  },
  {
    kind: 'chain', slug: '06-close', dur: 9, active: 3,
    title: 'The result is a team asset.',
    sub: 'Not a dotfile nobody else can use.',
    loopLabel: 'the next round starts faster',
    onScreen: 'The result is a team asset, not a dotfile \u2014 so the next round starts faster. That is the whole loop.',
  },
  {
    kind: 'card', slug: '07-channels', dur: 8,
    onScreen: 'And it runs when you are not at the desk \u2014 same session, same capabilities, in WeCom, Feishu, Discord, KOOK, WeChat or Email.',
  },
  {
    kind: 'end', slug: '08-end', dur: 6,
    onScreen: 'TeamClu \u2014 MIT licensed, open source, in beta. teamclu.ai',
  },
];

// ── Renderers ──────────────────────────────────────────────────────────────

function renderTitle(s, dest) {
  run(MAGICK, [
    ...frame(),
    ...accentBar(566, 128),
    ...text(FONT_BOLD, 128, INK, BRAND, TEXT_X, 566),
    ...text(FONT_REGULAR, 46, MUTED, 'Assign \u00b7 Build \u00b7 Review \u00b7 Compound', TEXT_X + 4, 654),
  ].concat(['-depth', '8', dest]));
}

function renderEnd(s, dest) {
  run(MAGICK, [
    ...frame(),
    ...accentBar(530, 128),
    ...text(FONT_BOLD, 128, INK, BRAND, TEXT_X, 530),
    ...text(FONT_REGULAR, 44, MUTED, 'The loop your team\u2019s AI work runs on.', TEXT_X + 4, 606),
    ...text(FONT_BOLD, 56, INK, SITE, TEXT_X + 4, 712),
    ...text(FONT_REGULAR, 30, FAINT, 'MIT licensed \u00b7 open source \u00b7 in beta', TEXT_X + 4, 772),
  ].concat(['-depth', '8', dest]));
}

function renderChain(s, dest) {
  const parts = [
    ...frame(),
    ...drawChain(s.active, { loopLabel: s.loopLabel }),
  ];
  if (s.title) {
    parts.push(...text(FONT_BOLD, 62, INK, s.title, 258, 300));
  }
  if (s.sub) {
    parts.push(...text(FONT_REGULAR, 34, MUTED, s.sub, 260, 372));
  }
  if (s.eyebrow) {
    // y=132, not 226: at 226 the badge (62px tall) ran into the 62pt title,
    // whose cap top starts around y=255.
    parts.push(...badge(s.eyebrow[0], 258, 132));
    parts.push(...text(FONT_REGULAR, 26, MUTED, s.eyebrow[1], 348, 172));
  }
  run(MAGICK, [...parts, '-depth', '8', dest]);
}

/**
 * A real product screenshot, fit to frame. The gallery frames are 1270×760
 * (1.671) on a 1.778 canvas, so fitting to height leaves a ~3% bar each side
 * filled with the frame's own background — the seam is invisible. No crop, so
 * nothing is lost, and no motion: the image is placed once and held.
 */
function renderShot(s, dest) {
  const src = path.join(GALLERY, s.src);
  if (!existsSync(src)) {
    throw new Error(`missing gallery frame: ${src}\nRebuild with: node scripts/build-producthunt-gallery.mjs`);
  }
  const innerW = Math.round((1270 / 760) * HEIGHT);
  run(MAGICK, [
    '-size', `${WIDTH}x${HEIGHT}`, `xc:${BG}`,
    '(', src, '-filter', 'Lanczos', '-resize', `${innerW}x${HEIGHT}!`, ')',
    '-gravity', 'center', '-composite',
    // Reset gravity before drawing the step badge: `-gravity center` applies to
    // -annotate too, which made +X+Y centre-relative and pushed both the
    // number and the label off the bottom of the frame — they rendered as two
    // empty chips.
    '-gravity', 'northwest',
    // Step badge over the image, bottom-left, on a paper chip so it stays legible.
    ...badge(s.step, 96, HEIGHT - 178),
    ...roundRect(176, HEIGHT - 186, s.label.length * 16 + 44, 78, 14, BORDER, 1.5, PAPER),
    ...text(FONT_REGULAR, 28, INK2, s.label, 200, HEIGHT - 186 + 49),
    '-depth', '8', dest,
  ]);
}

/**
 * The REVIEW beat. A labelled spec diagram comparing a human message bubble to
 * an agent note — not a product screenshot, and not pretending to be one. The
 * distinction is the single most load-bearing visual decision in the chat UI
 * (docs/features/03 §3.2: "agent 回复不是气泡，是笔记").
 */
function renderAnatomy(s, dest) {
  const parts = [...frame(), ...badge(s.step), ...text(FONT_REGULAR, 26, MUTED, s.label, 186, 168)];

  parts.push(...text(FONT_BOLD, 54, INK, 'An agent does not talk in bubbles.', 258, 286));
  parts.push(...text(FONT_REGULAR, 32, MUTED, 'It answers in notes. Humans keep the bubbles.', 260, 352));

  const top = 448;
  const colH = 420;

  // ── left: the bubble ──
  const bx = 258;
  const bw = 560;
  parts.push(...text(FONT_BOLD, 22, MUTED, 'HUMAN MESSAGE \u00b7 BUBBLE', bx, top - 26));
  parts.push(...roundRect(bx, top, bw, 120, 16, BORDER, 1.5, INK));
  parts.push(...roundRect(bx, top + 120 - 26, 26, 26, 6, INK, 0, INK)); // speaker corner
  parts.push(...text(FONT_REGULAR, 26, '#fefdfa', 'can you break down the release notes?', bx + 30, top + 46));
  parts.push(...text(FONT_REGULAR, 26, '#fefdfa', 'who is on point for the rollout?', bx + 30, top + 88));
  [
    ['width by content', bx + 26, top + 172],
    ['one voice, one turn', bx + 26, top + 212],
    ['nothing to approve', bx + 26, top + 252],
  ].forEach(([t, x, y]) => {
    parts.push(['-fill', BORDER, '-draw', `circle ${P(x - 9)},${P(y - 8)} ${P(x - 5)},${P(y - 8)}`]);
    parts.push(...text(FONT_REGULAR, 23, MUTED, t, x, y));
  });

  // ── right: the note ──
  const nx = 900;
  const nw = WIDTH - nx - 258;
  parts.push(...text(FONT_BOLD, 22, MUTED, 'AGENT REPLY \u00b7 NOTE', nx, top - 26));
  parts.push(...roundRect(nx, top, nw, colH, 16, BORDER, 1.5, PAPER));
  // meta strip
  parts.push(...roundRect(nx + 28, top + 26, 26, 26, 6, BORDER, 0, BORDER));
  parts.push(...text(FONT_BOLD, 22, INK2, 'release-agent', nx + 66, top + 47));
  parts.push(...text(FONT_REGULAR, 20, FAINT, 'pi \u00b7 19:47', nx + 66, top + 76));
  // body
  parts.push(...text(FONT_REGULAR, 25, INK2, 'Three owners. Two decisions still open:', nx + 28, top + 128));
  parts.push(...line(nx + 28, top + 152, nx + nw - 28, top + 152, BORDER, 1));
  const grid = [
    ['ROLLBACK', 'not decided \u2014 needs a name'],
    ['WINDOW', 'Thursday 02:00 UTC'],
    ['FREEZE', 'Wednesday 18:00'],
  ];
  grid.forEach(([k, v], i) => {
    const y = top + 196 + i * 46;
    parts.push(...text(FONT_REGULAR, 22, MUTED, k, nx + 28, y));
    parts.push(...text(FONT_REGULAR, 22, INK, v, nx + 190, y));
  });
  // follow-up pills
  ['draft the rollback note', 'who is on call?'].forEach((t, i) => {
    const x = nx + 28 + i * (t.length * 6.6 + 34);
    parts.push(...roundRect(x, top + 342, t.length * 6.6 + 26, 40, 8, BORDER, 1.5, PAPER));
    parts.push(...text(FONT_REGULAR, 20, INK2, t, x + 13, top + 368));
  });
  // Callout sits BELOW the note card, not above it: at top-92 it landed on the
  // same baseline as the intro sub-line and overprinted it.
  parts.push(...text(FONT_REGULAR, 23, MUTED, 'full width \u2014 it is a document, not a turn', nx + 28, top + colH + 52));

  run(MAGICK, [...parts, '-depth', '8', dest]);
}

function renderCard(s, dest) {
  run(MAGICK, [
    ...frame(),
    ...accentBar(470, 54),
    ...text(FONT_BOLD, 54, INK, 'And it runs when you are not at the desk.', TEXT_X, 470),
    ...text(FONT_REGULAR, 34, MUTED, 'Same session. Same capabilities.', TEXT_X + 4, 548),
    ...text(FONT_BOLD, 38, INK, 'WeCom \u00b7 Feishu \u00b7 Discord \u00b7 KOOK \u00b7 WeChat \u00b7 Email', TEXT_X + 4, 640),
    ...text(FONT_REGULAR, 26, FAINT, 'capability lives in the kernel, not in the channel', TEXT_X + 4, 700),
  ].concat(['-depth', '8', dest]));
}

// ── Build ──────────────────────────────────────────────────────────────────

rmSync(TMP, { recursive: true, force: true });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(STILLS, { recursive: true });
mkdirSync(OUT, { recursive: true });

// Durations snapped to whole frames: hard cuts must not drift.
const frames = SCENES.map((s) => Math.max(1, Math.round(s.dur * FPS)));
SCENES.forEach((s, i) => { s.frames = frames[i]; });

const RENDERERS = {
  title: renderTitle,
  end: renderEnd,
  chain: renderChain,
  shot: renderShot,
  anatomy: renderAnatomy,
  card: renderCard,
};

const stills = SCENES.map((s, i) => {
  const dest = path.join(STILLS, `${String(i).padStart(2, '0')}-${s.slug}.png`);
  const fn = RENDERERS[s.kind];
  if (!fn) throw new Error(`unknown scene kind "${s.kind}" at index ${i} (${s.slug})`);
  try {
    fn(s, dest);
  } catch (err) {
    const why = (err.stderr || Buffer.alloc(0)).toString().trim() || err.message;
    throw new Error(`failed rendering scene ${i} (${s.slug}, kind=${s.kind}):\n${why}`);
  }
  return dest;
});

const mp4 = path.join(OUT, `teamclu-loop-${HEIGHT}p.mp4`);

// Hard cuts, exact durations. The concat FILTER is used rather than the
// concat demuxer because the demuxer holds its repeated tail frame for a full
// extra duration (measured: 93s for an 87s timeline) and gives no way to say
// "this input is exactly N frames".
const args = [];
SCENES.forEach((s, i) => {
  args.push('-loop', '1', '-framerate', String(FPS), '-t', String(s.frames / FPS), '-i', stills[i]);
});

// Normalise every input to identical size / pixel format / SAR / frame rate,
// because the concat filter requires it and PNG inputs do not agree by default.
const NORM = `fps=${FPS},scale=${WIDTH}:${HEIGHT}:flags=lanczos,format=yuv420p,setsar=1`;
const chain = SCENES.map((_, i) => `[${i}:v]${NORM}[v${i}]`);
// No extra brackets here: each label already carries its own.
const concat =
  SCENES.map((_, i) => `[v${i}]`).join('') +
  `concat=n=${SCENES.length}:v=1:a=0[vout]`;

args.push(
  '-filter_complex', `${chain.join(';')};${concat}`,
  '-map', '[vout]',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
  '-profile:v', 'high', '-level', '4.0', '-pix_fmt', 'yuv420p',
  '-r', String(FPS), '-movflags', '+faststart',
  '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
  mp4,
);

run(FFMPEG, args);

const stamp = (v) => {
  const h = String(Math.floor(v / 3600)).padStart(2, '0');
  const m = String(Math.floor((v % 3600) / 60)).padStart(2, '0');
  const sec = String(Math.floor(v % 60)).padStart(2, '0');
  const ms = String(Math.round((v % 1) * 1000)).padStart(3, '0');
  return `${h}:${m}:${sec},${ms}`;
};
let t = 0;
const srtLines = [];
SCENES.forEach((s, i) => {
  const start = t;
  t += s.frames / FPS;
  srtLines.push(String(i + 1), `${stamp(start)} --> ${stamp(t)}`, s.onScreen, '');
});
const srtPath = path.join(OUT, `teamclu-loop-${HEIGHT}p.srt`);
writeFileSync(srtPath, srtLines.join('\n'));

// Keep the stills: they are the editable source for any re-cut.
const stillOut = path.join(OUT, 'stills');
rmSync(stillOut, { recursive: true, force: true });
mkdirSync(stillOut, { recursive: true });
stills.forEach((f, i) => {
  execFileSync('cp', [f, path.join(stillOut, path.basename(f))]);
});

const probe = run(FFPROBE, [
  '-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height,r_frame_rate,nb_frames:format=duration,size',
  '-of', 'default=noprint_wrappers=1', mp4,
]).trim();

process.stdout.write(`built ${path.relative(ROOT, mp4)}\n${probe}\n`);
process.stdout.write(`built ${path.relative(ROOT, srtPath)} (${SCENES.length} cues, ${t.toFixed(1)}s)\n`);
process.stdout.write(`stills -> ${path.relative(ROOT, stillOut)}\n`);
