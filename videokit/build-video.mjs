#!/usr/bin/env node
/**
 * Build the TeamClu launch video: a Ken Burns tour over the five real
 * Product Hunt gallery frames, plus an opening and closing card.
 *
 *   node videokit/build-video.mjs
 *
 * Why motion-graphics over a screen recording: the running-app footage is not
 * in this repo, and the PH kit's own rule (producthunt-kit/README.md §5) is that
 * nothing fake may pose as a product screenshot. These five frames ARE the real
 * UI — see scripts/build-producthunt-gallery.mjs, which composites them from
 * captured PNGs. The video adds no invented screens, only camera moves.
 *
 * It is also silent. Adding a music bed or a VO track is a one-line mux once you
 * have one — see videokit/README.md.
 *
 * Requires: ImageMagick (brew install imagemagick) and ffmpeg with libx264.
 *
 * Env overrides:
 *   MAGICK       command name / path (default: magick)
 *   FFMPEG       command name / path (default: ffmpeg)
 *   FFPROBE      command name / path (default: ffprobe)
 *   VIDEO_FPS    frames per second (default: 30)
 *   VIDEO_SCALE  "1080" or "720" (default: 1080)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(KIT, '..');
const GALLERY = path.join(ROOT, 'producthunt-kit', 'screenshots');
const TMP = path.join(KIT, '.tmp');
const OUT = path.join(KIT, 'out');

const MAGICK = process.env.MAGICK || 'magick';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const FPS = Number(process.env.VIDEO_FPS || 30);
const HEIGHT = Number(process.env.VIDEO_SCALE || 1080) === 720 ? 720 : 1080;
const WIDTH = (HEIGHT * 16) / 9; // 1920 / 1280

const FONT_BOLD =
  process.env.VIDEO_FONT_BOLD || '/System/Library/Fonts/Supplemental/Arial Bold.ttf';
const FONT_REGULAR =
  process.env.VIDEO_FONT_REGULAR || '/System/Library/Fonts/Supplemental/Arial.ttf';

// Editorial Calm tokens (AGENTS.md §1) — the same values the gallery uses.
const BG = '#fbfaf7';
const INK = '#1a1a14';
const MUTED = '#75736a';
const CORAL = '#e85a4a';
const FAINT = '#a8a6a0';

const XFADE = 0.5; // seconds of cross-dissolve between scenes
const BRAND = 'TeamClu';
const TAGLINE = "Shared skills and group chat for your team's AI agents.";
const SITE = 'teamclu.ai';

/**
 * Scene order is the launch narrative, not the gallery order: the workspace
 * establishes what the product is, then the two claims PH leads with
 * (group chat, team skills) get the longest dwells, then reach and browser.
 *
 * `z0 → z1` is the camera move across the shot's duration. `fx/fy` are the
 * focal point as a fraction of the frame.
 *
 * Why the moves are small and centred: each frame's headline and subtitle are
 * burned in at the top-left, roughly y 0.12–0.21 and x 0.10–0.56. zoompan
 * always crops a centred window of 1/z of the frame, so the visible top edge
 * is `fy − 1/(2z)`. At z 1.16 an fy of 0.62 puts that edge at 0.19 — the
 * headline is cropped and the shot opens on "kills your whole team shares".
 * Keeping fy ≤ ~0.52 at z ≤ 1.12 holds the top edge at 0.12 or above, so the
 * title survives the whole move. If you want to emphasise a region, re-shoot
 * the frame without a baked-in headline first rather than zooming harder.
 *
 * `caption` becomes the .srt track; keep it identical to the text already on
 * the frame so the captions describe what is on screen.
 */
const SCENES = [
  { kind: 'card', slug: '00-title', dur: 4, z0: 1.0, z1: 1.05, fx: 0.5, fy: 0.5,
    caption: 'TeamClu — shared skills and group chat for your team\u2019s AI agents.' },
  { kind: 'shot', slug: '01-workspace', src: 'ph-1-workspace-1270x760.png', dur: 9,
    z0: 1.0, z1: 1.08, fx: 0.5, fy: 0.54,
    caption: 'Your team and its agents, one workspace.' },
  { kind: 'shot', slug: '02-group-chat', src: 'ph-4-group-session-1270x760.png', dur: 10,
    z0: 1.0, z1: 1.12, fx: 0.51, fy: 0.52,
    caption: 'Sessions are group chats \u2014 teammates and agents in one thread.' },
  { kind: 'shot', slug: '03-team-skills', src: 'ph-2-team-skills-1270x760.png', dur: 10,
    z0: 1.0, z1: 1.12, fx: 0.5, fy: 0.52,
    caption: 'Skills your whole team shares \u2014 publish once, everyone\u2019s agent follows.' },
  { kind: 'shot', slug: '04-channels', src: 'ph-3-channels-1270x760.png', dur: 8,
    z0: 1.06, z1: 1.0, fx: 0.5, fy: 0.52,
    caption: 'Reach your agents in WeCom, Feishu, Discord, KOOK, WeChat and Email.' },
  { kind: 'shot', slug: '05-extension', src: 'ph-5-extension-1270x760.png', dur: 8,
    z0: 1.08, z1: 1.0, fx: 0.5, fy: 0.52,
    caption: 'Agents in your browser side panel.' },
  { kind: 'end', slug: '06-end', dur: 6, z0: 1.0, z1: 1.04, fx: 0.5, fy: 0.5,
    caption: 'TeamClu \u2014 MIT licensed, open source, in beta. teamclu.ai' },
];

function run(cmd, args) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).toString();
}

// ── Stills ─────────────────────────────────────────────────────────────────

/** Letterbox a 1270×760 gallery frame onto the 16:9 canvas, centred. */
function renderShot(src, dest) {
  // The gallery frame is 1270×760 (1.671) and the canvas is 1.778, so fitting to
  // height leaves a thin bar each side — filled with the frame's own background
  // so the seam is invisible.
  const innerH = HEIGHT;
  const innerW = Math.round((1270 / 760) * innerH);
  run(MAGICK, [
    '-size', `${WIDTH}x${HEIGHT}`, `xc:${BG}`,
    '(', src, '-filter', 'Lanczos', '-resize', `${innerW}x${innerH}!`, ')',
    '-gravity', 'center', '-composite',
    '-depth', '8', dest,
  ]);
}

function cardArgs(dest) {
  return [
    '-size', `${WIDTH}x${HEIGHT}`, `xc:${BG}`,
    // One coral bar, same gesture as the gallery frames.
    '-fill', CORAL, '-draw', `rectangle 258,436 270,492`,
    '-font', FONT_BOLD, '-fill', INK, '-pointsize', 128,
    '-annotate', '+254+566', BRAND,
    '-font', FONT_REGULAR, '-fill', MUTED, '-pointsize', 44,
    '-annotate', '+258+640', TAGLINE,
  ];
}

function renderTitle(dest) {
  run(MAGICK, [...cardArgs(dest), '-depth', '8', dest]);
}

function renderEnd(dest) {
  run(MAGICK, [
    ...cardArgs(dest),
    '-font', FONT_BOLD, '-fill', INK, '-pointsize', 54,
    '-annotate', '+258+736', SITE,
    '-font', FONT_REGULAR, '-fill', FAINT, '-pointsize', 30,
    '-annotate', '+258+798', 'MIT licensed \u00b7 open source \u00b7 in beta',
    '-depth', '8', dest,
  ]);
}

// ── Motion ─────────────────────────────────────────────────────────────────

/**
 * One segment per scene: pre-scale 2× so zoompan downsamples rather than
 * upscales (this is also what keeps the pan from stepping in whole pixels),
 * then push/pull to the scene's focal point.
 */
function segment(i, s) {
  const frames = Math.round(s.dur * FPS);
  const pre = `${WIDTH * 2}x${HEIGHT * 2}`;
  const zoom = `${s.z0}+(${s.z1 - s.z0})*on/${frames - 1}`;
  const x = `max(0\\,min(${s.fx}*iw-(iw/zoom/2)\\,iw-iw/zoom))`;
  const y = `max(0\\,min(${s.fy}*ih-(ih/zoom/2)\\,ih-ih/zoom))`;
  return (
    `[${i}:v]scale=${pre}:flags=lanczos,setsar=1,` +
    `zoompan=z='${zoom}':x='${x}':y='${y}':d=1:s=${WIDTH}x${HEIGHT}:fps=${FPS},` +
    `unsharp=5:5:0.5:5:5:0.0,format=yuv420p,settb=AVTB[v${i}]`
  );
}

/** Captions track the dwells, so they start when the cross-dissolve lands. */
function srt() {
  const lines = [];
  let t = 0;
  SCENES.forEach((s, i) => {
    if (i > 0) t += XFADE / 2;
    const start = t;
    t += s.dur - (i > 0 ? XFADE / 2 : 0) - (i < SCENES.length - 1 ? XFADE : 0);
    const end = t;
    const stamp = (v) => {
      const h = String(Math.floor(v / 3600)).padStart(2, '0');
      const m = String(Math.floor((v % 3600) / 60)).padStart(2, '0');
      const sec = String(Math.floor(v % 60)).padStart(2, '0');
      const ms = String(Math.round((v % 1) * 1000)).padStart(3, '0');
      return `${h}:${m}:${sec},${ms}`;
    };
    lines.push(String(i + 1), `${stamp(start)} --> ${stamp(end)}`, s.caption, '');
  });
  return lines.join('\n');
}

// ── Build ──────────────────────────────────────────────────────────────────

rmSync(TMP, { recursive: true, force: true });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
mkdirSync(OUT, { recursive: true });

const stills = SCENES.map((s) => {
  const dest = path.join(TMP, `${s.slug}.png`);
  if (s.kind === 'shot') {
    const src = path.join(GALLERY, s.src);
    if (!existsSync(src)) {
      throw new Error(
        `missing gallery frame: ${src}\n` +
          `Rebuild it with: node scripts/build-producthunt-gallery.mjs`
      );
    }
    renderShot(src, dest);
  } else if (s.kind === 'end') renderEnd(dest);
  else renderTitle(dest);
  return dest;
});

const mp4 = path.join(OUT, `teamclu-tour-${HEIGHT}p.mp4`);
const args = [];
// `-t` per input is load-bearing: `-loop 1` is unbounded, and zoompan's `d=1`
// emits one output frame per input frame, so an unbounded input never ends.
SCENES.forEach((s, i) => {
  args.push('-loop', '1', '-framerate', String(FPS), '-t', String(s.dur), '-i', stills[i]);
});
args.push('-filter_complex', (() => {
  const parts = SCENES.map((s, i) => segment(i, s));
  let prev = 'v0';
  let acc = Math.round(SCENES[0].dur * FPS);
  for (let k = 1; k < SCENES.length; k += 1) {
    const offset = (acc - XFADE * FPS) / FPS;
    parts.push(`[${prev}][v${k}]xfade=transition=fade:duration=${XFADE}:offset=${offset.toFixed(3)}[x${k}]`);
    prev = `x${k}`;
    acc += Math.round(SCENES[k].dur * FPS) - XFADE * FPS;
  }
  parts.push(`[${prev}]format=yuv420p[vout]`);
  return parts.join(';');
})());
args.push(
  '-map', '[vout]', '-an',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '19',
  '-profile:v', 'high', '-level', '4.0', '-pix_fmt', 'yuv420p',
  '-r', String(FPS), '-movflags', '+faststart',
  '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
  mp4
);

run(FFMPEG, args);

const srtPath = path.join(OUT, `teamclu-tour-${HEIGHT}p.srt`);
writeFileSync(srtPath, srt());

const probe = run(FFPROBE, [
  '-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height,r_frame_rate,nb_frames:format=duration,size',
  '-of', 'default=noprint_wrappers=1', mp4,
]).trim();

process.stdout.write(`built ${path.relative(ROOT, mp4)}\n${probe}\n`);
process.stdout.write(`built ${path.relative(ROOT, srtPath)}\n`);
