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
import { createDesign } from '../kits/design.mjs';

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

const BRAND = 'TeamClu';
const SITE = 'teamclu.ai';

// Design primitives live in kits/design.mjs, shared with posterkit. Every
// measurement rule that had to be debugged the hard way is documented there:
// cap lines and ink widths are measured, never estimated, and fit/overflow
// warnings land in `notes` for the audit printed at the end of the build.
const design = createDesign({
  width: WIDTH,
  height: HEIGHT,
  magick: MAGICK,
  fonts: { bold: FONT_BOLD, regular: FONT_REGULAR },
});
const {
  T: { paper: PAPER, ink: INK, ink2: INK2, muted: MUTED, faint: FAINT, border: BORDER, coral: CORAL },
  notes, SAFE_RIGHT,
  frame, roundRect, line, poly, dot, P,
  text, textCentered, textRight, textFit, pill, fitSize, ink, capOffset, capTop,
  accentBar, badge, ACTORS, disc, cluster,
  run: magickRun,
} = design;

/** accentBar with this kit's left margin for the hanging-bar cards. */
const ACCENT_X = 224;
const TEXT_X = 254;
function bar(baseline, size) {
  return accentBar(baseline, size, { x: ACCENT_X });
}

/** exec for ffmpeg/ffprobe, which take a command; magick runs via design.run. */
function runCmd(cmd, args) {
  const clean = args.flat(Infinity).filter((a) => a !== null && a !== undefined && a !== '').map(String);
  return execFileSync(cmd, clean, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).toString();
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
    kind: 'session', slug: '02-assign', dur: 13, step: 1, label: 'ASSIGN',
    prefer: 'assign-en.png',
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
    kind: 'skill', slug: '05-compound', dur: 15, step: 4, label: 'COMPOUND',
    prefer: 'compound-en.png',
    onScreen: 'The result becomes a team asset, not a dotfile. Publish once with a changelog and every teammate\u2019s agent follows it.',
  },
  {
    kind: 'chain', slug: '06-close', dur: 9, active: 3,
    title: 'And the next round starts faster.',
    sub: 'That is the whole loop.',
    loopLabel: 'and round again',
    onScreen: 'And the next round starts faster. That is the whole loop.',
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

// ── The two beats that used to be Chinese screenshots ───────────────────────
// Every real capture in the repo has Chinese in it: the app was running in zh
// when they were taken. `images/home.png` is English chrome but its session
// previews still read "## `.opencode/skills/` 技能清单" and "TeamClu 是一个多智能体
// 协作平台". There is no clean English capture to swap in, so both beats are
// drawn as spec diagrams — labelled illustrations of the documented model
// (03 §2, §7.1–7.3 for the session; 06 §3.1, §4, §6 for the skill), NOT captures.
//
// If an English capture lands, drop it at videokit/src/<name>.png and re-run:
// SCENES.prefer names the file and the shot renderer takes over automatically.

/** ASSIGN — a session is a group, not a 1:1 bot chat. */
function renderSession(s, dest) {
  const px = 258;
  const pw = WIDTH - px * 2;
  const py = 400;
  const ph = 480;
  const ix = px + 32;          // inner left
  const ir = px + pw - 32;     // inner right
  const inner = pw - 64;

  const parts = [
    ...frame(),
    ...badge(s.step, 96, 128),
    ...text(FONT_REGULAR, 26, MUTED, s.label, 186, 168),
    ...textFit(FONT_BOLD, 54, INK, 'One session. Teammates and agents, same context.', TEXT_X, 300, inner + 8),
    ...textFit(FONT_REGULAR, 32, MUTED, '@mention an agent and it answers as a participant.', TEXT_X, 358, inner + 8),
    ...roundRect(px, py, pw, ph, 16, BORDER, 1.5, PAPER),
  ];

  // header: session title + participant cluster + presence line
  parts.push(...textFit(FONT_BOLD, 27, INK, 'Release 3.4 \u2014 go / no-go', ix, py + 56, inner - 220));
  const cl = cluster(ACTORS, ir, py + 30, 34, 9);
  parts.push(...cl.args);
  parts.push(...textRight(FONT_REGULAR, 22, MUTED, '3 people \u00b7 2 agents \u00b7 all online', ir, py + 98));
  parts.push(...line(ix, py + 122, ir, py + 122, BORDER, 1));

  // a teammate's message: paper bubble, left, with the speaker above it
  parts.push(...text(FONT_REGULAR, 20, MUTED, 'Dana \u00b7 19:46', ix, py + 156));
  const say = 'Rollback window is still open \u2014 @release-agent, pin an owner?';
  const bcap = capOffset(FONT_REGULAR, 24);
  const bw = Math.min(inner * 0.86, ink(say, FONT_REGULAR, 24).w + 60);
  parts.push(...roundRect(ix, py + 170, bw, bcap + 38, 16, BORDER, 1.5, PAPER));
  parts.push(...text(FONT_REGULAR, 24, INK, say, ix + 30, py + 170 + 28 + bcap));

  // the agent answers as a participant — a note, not a bubble
  parts.push(...roundRect(ix + 33, py + 258, 26, 26, 6, BORDER, 0, BORDER));
  parts.push(...text(FONT_BOLD, 22, INK, 'release-agent', ix + 69, py + 280));
  parts.push(...text(FONT_REGULAR, 20, FAINT, 'pi \u00b7 19:47', ix + 69, py + 308));
  parts.push(...textFit(FONT_REGULAR, 24, INK2, 'One decision is still open. Everything else is locked.', ix + 33, py + 350, inner - 33));
  parts.push(...line(ix + 33, py + 372, ir, py + 372, BORDER, 1));
  [['ROLLBACK', 'not decided'], ['WINDOW', 'Thursday 02:00 UTC']].forEach(([k, v], i) => {
    const y = py + 406 + i * 40;
    parts.push(...text(FONT_REGULAR, 22, MUTED, k, ix + 33, y));
    parts.push(...textFit(FONT_REGULAR, 22, INK, v, ix + 33 + 180, y, inner - 213));
  });

  parts.push(...textFit(FONT_REGULAR, 24, MUTED,
    'It can be offline, permission-limited, or switched to another model mid-conversation.',
    TEXT_X, py + ph + 56, WIDTH - TEXT_X - SAFE_RIGHT));

  magickRun([...parts, '-depth', '8', '-strip', dest]);
}

/** COMPOUND — a skill is a versioned team object, not a personal dotfile. */
function renderSkill(s, dest) {
  const px = 258;
  const pw = WIDTH - px * 2;
  const py = 400;
  const ph = 480;
  const ix = px + 32;
  const ir = px + pw - 32;
  const inner = pw - 64;
  const colW = Math.round(inner / 2) - 24;

  const parts = [
    ...frame(),
    ...badge(s.step, 96, 128),
    ...text(FONT_REGULAR, 26, MUTED, s.label, 186, 168),
    ...textFit(FONT_BOLD, 54, INK, 'The result is a team asset, not a dotfile.', TEXT_X, 300, inner + 8),
    ...textFit(FONT_REGULAR, 32, MUTED, 'Publish once with a changelog; every teammate\u2019s agent follows.', TEXT_X, 358, inner + 8),
    ...roundRect(px, py, pw, ph, 16, BORDER, 1.5, PAPER),
  ];

  // header
  parts.push(...textFit(FONT_BOLD, 30, INK, 'website-editor', ix, py + 58, inner - 300));
  parts.push(...textRight(FONT_REGULAR, 22, MUTED, 'general \u00b7 owned by Bertrand', ir, py + 58));
  parts.push(...line(ix, py + 82, ir, py + 82, BORDER, 1));

  // when to use / when not to use — the second one is the required field
  const cols = [
    ['WHEN TO USE', ['Modify teamclaw-web content', 'through chat, then open a PR.']],
    ['WHEN NOT TO USE', ['Editing files directly.', 'No \u2014 nothing is a hard no.']],
  ];
  cols.forEach(([head, lines], c) => {
    const x = ix + c * (colW + 48);
    parts.push(...text(FONT_BOLD, 20, c === 1 ? INK2 : MUTED, head, x, py + 122));
    lines.forEach((t, i) => {
      parts.push(...textFit(FONT_REGULAR, 22, INK2, t, x, py + 156 + i * 30, colW));
    });
  });
  parts.push(...line(ix, py + 214, ir, py + 214, BORDER, 1));

  // version history
  parts.push(...text(FONT_BOLD, 20, MUTED, 'VERSIONS', ix, py + 252));
  const rows = [
    ['v2', 'installed', 'support windows', 'Sep 5, 2026', true],
    ['v1', '', 'shared from a personal skill', 'restore this version', false],
  ];
  rows.forEach(([v, tag, note, right, isLatest], i) => {
    const y = py + 300 + i * 78;
    parts.push(...text(FONT_BOLD, 24, INK, v, ix, y));
    // the tag pill pushes the changelog right; hardcoding the note at ix+96 put
    // "installed" on top of "support windows"
    let nx2 = ix + ink(v, FONT_BOLD, 24).w + 16;
    if (tag) {
      const tp = pill(tag, FONT_REGULAR, 18, nx2, y - 21, { padX: 10, padY: 5, radius: 4 });
      parts.push(...tp.args);
      nx2 += tp.width + 14;
    }
    parts.push(...textFit(FONT_REGULAR, 22, MUTED, note, nx2, y, ir - 260 - nx2));
    parts.push(...textRight(FONT_REGULAR, 22, FAINT, right, ir, y));
    if (isLatest) parts.push(...line(ix, y + 22, ir, y + 22, BORDER, 1));
  });

  parts.push(...textFit(FONT_REGULAR, 24, MUTED,
    'Installed skills follow the newest version on a 10-minute reconcile. Edit one locally and you get a conflict \u2014 never a silent overwrite.',
    TEXT_X, py + ph + 56, WIDTH - TEXT_X - SAFE_RIGHT));

  magickRun([...parts, '-depth', '8', '-strip', dest]);
}

// ── Card renderers ─────────────────────────────────────────────────────────

function renderTitle(s, dest) {
  magickRun([
    ...frame(),
    ...bar(566, 128),
    ...text(FONT_BOLD, 128, INK, BRAND, TEXT_X, 566),
    ...text(FONT_REGULAR, 46, MUTED, 'Assign \u00b7 Build \u00b7 Review \u00b7 Compound', TEXT_X + 4, 654),
  ].concat(['-depth', '8', '-strip', dest]));
}

function renderEnd(s, dest) {
  magickRun([
    ...frame(),
    ...bar(530, 128),
    ...text(FONT_BOLD, 128, INK, BRAND, TEXT_X, 530),
    ...text(FONT_REGULAR, 44, MUTED, 'The loop your team\u2019s AI work runs on.', TEXT_X + 4, 606),
    ...text(FONT_BOLD, 56, INK, SITE, TEXT_X + 4, 712),
    ...text(FONT_REGULAR, 30, FAINT, 'MIT licensed \u00b7 open source \u00b7 in beta', TEXT_X + 4, 772),
  ].concat(['-depth', '8', '-strip', dest]));
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
  magickRun([...parts, '-depth', '8', '-strip', dest]);
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
  magickRun([
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
    '-depth', '8', '-strip', dest,
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
  // follow-up pills, laid out from measured widths (see pill())
  let px = nx + 28;
  for (const t of ['draft the rollback note', 'who is on call?']) {
    const p = pill(t, FONT_REGULAR, 20, px, top + 342, { maxW: nw - 28 });
    parts.push(...p.args);
    px += p.width + 10;
  }
  // Callout sits BELOW the note card, not above it: at top-92 it landed on the
  // same baseline as the intro sub-line and overprinted it.
  parts.push(...text(FONT_REGULAR, 23, MUTED, 'full width \u2014 it is a document, not a turn', nx + 28, top + colH + 52));

  magickRun([...parts, '-depth', '8', '-strip', dest]);
}

function renderCard(s, dest) {
  magickRun([
    ...frame(),
    ...bar(470, 54),
    ...text(FONT_BOLD, 54, INK, 'And it runs when you are not at the desk.', TEXT_X, 470),
    ...text(FONT_REGULAR, 34, MUTED, 'Same session. Same capabilities.', TEXT_X + 4, 548),
    ...text(FONT_BOLD, 38, INK, 'WeCom \u00b7 Feishu \u00b7 Discord \u00b7 KOOK \u00b7 WeChat \u00b7 Email', TEXT_X + 4, 640),
    ...text(FONT_REGULAR, 26, FAINT, 'capability lives in the kernel, not in the channel', TEXT_X + 4, 700),
  ].concat(['-depth', '8', '-strip', dest]));
}

// ── Build ──────────────────────────────────────────────────────────────────

rmSync(TMP, { recursive: true, force: true });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(STILLS, { recursive: true });
mkdirSync(OUT, { recursive: true });

// Durations snapped to whole frames: hard cuts must not drift.
const frames = SCENES.map((s) => Math.max(1, Math.round(s.dur * FPS)));
SCENES.forEach((s, i) => { s.frames = frames[i]; });

const SRC = path.join(KIT, 'src');

/** Prefer a real English capture at src/<prefer> when one has been dropped in. */
function resolve(s) {
  if (s.prefer) {
    const p = path.join(SRC, s.prefer);
    if (existsSync(p)) return { kind: 'shot', src: p };
    notes.push(`${s.slug}: using the ${s.kind} spec diagram (no src/${s.prefer})`);
  }
  return s;
}

const RENDERERS = {
  title: renderTitle,
  end: renderEnd,
  chain: renderChain,
  shot: renderShot,
  anatomy: renderAnatomy,
  card: renderCard,
  session: renderSession,
  skill: renderSkill,
};

const stills = SCENES.map((s, i) => {
  const dest = path.join(STILLS, `${String(i).padStart(2, '0')}-${s.slug}.png`);
  const r = resolve(s);
  const fn = RENDERERS[r.kind];
  if (!fn) throw new Error(`unknown scene kind "${r.kind}" at index ${i} (${s.slug})`);
  try {
    fn(r, dest);
  } catch (err) {
    const why = (err.stderr || Buffer.alloc(0)).toString().trim() || err.message;
    throw new Error(`failed rendering scene ${i} (${s.slug}, kind=${r.kind}):\n${why}`);
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
  // Without bitexact the mp4 muxer stamps a creation/modification time into the
  // mvhd atom — a binary field, NOT a visible tag, which is why `ffprobe
  // -show_entries format_tags` looks clean. The result is that the file bytes
  // differ between runs even when the input pixels are identical, so "did this
  // refactor change the video?" could not actually be answered by comparing
  // hashes. Confirmed by measurement: identical still signatures produced
  // different MP4 hashes.
  '-fflags', '+bitexact', '-flags:v', '+bitexact',
  '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
  mp4,
);

runCmd(FFMPEG, args);

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

const probe = runCmd(FFPROBE, [
  '-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height,r_frame_rate,nb_frames:format=duration,size',
  '-of', 'default=noprint_wrappers=1', mp4,
]).trim();

process.stdout.write(`built ${path.relative(ROOT, mp4)}\n${probe}\n`);
process.stdout.write(`built ${path.relative(ROOT, srtPath)} (${SCENES.length} cues, ${t.toFixed(1)}s)\n`);
process.stdout.write(`stills -> ${path.relative(ROOT, stillOut)}\n`);
if (notes.length) {
  process.stdout.write(`\n${notes.length} layout note(s):\n${notes.map((n) => `  - ${n}`).join('\n')}\n`);
} else {
  process.stdout.write('\nlayout audit: no overflow, nothing shrunk to fit\n');
}
