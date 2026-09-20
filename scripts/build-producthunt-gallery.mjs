#!/usr/bin/env node
/**
 * Build the Product Hunt gallery for TeamClu: frames at 1270×760.
 *
 *   node scripts/build-producthunt-gallery.mjs
 *
 * The gallery is ordered around the team story (shared Skills + group chat),
 * not around the desktop/extension feature list. Two of the five slots are
 * `optional: true` because the screenshots that sell the team story are not in
 * this repo yet — see producthunt-kit/src/README.md for exactly what to capture.
 * Drop those PNGs at the listed path and re-run; they slot in automatically.
 *
 * Why ImageMagick and not a headless browser: this repo has no Playwright /
 * Puppeteer dependency, and macOS Chrome refuses to start under the DSH file
 * sandbox (it cannot write its Crashpad directory).
 *
 *   brew install imagemagick
 *
 * Env overrides:
 *   MAGICK            command name / path (default: magick)
 *   PH_FONT_BOLD      headline + brand font (default: Arial Bold.ttf)
 *   PH_FONT_REGULAR   subtitle font (default: Arial.ttf)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'producthunt-kit', 'screenshots');
const TMP_DIR = path.join(OUT_DIR, '.tmp');

const MAGICK = process.env.MAGICK || 'magick';
const FONT_BOLD =
  process.env.PH_FONT_BOLD || '/System/Library/Fonts/Supplemental/Arial Bold.ttf';
const FONT_REGULAR =
  process.env.PH_FONT_REGULAR || '/System/Library/Fonts/Supplemental/Arial.ttf';

// ── Frame geometry (Product Hunt's recommended gallery size) ────────────────
const W = 1270;
const H = 760;
const CARD_MAX_W = 1158;
const CARD_MAX_H = 560;
const CARD_TOP = 172;
const RADIUS = 16;

// Editorial Calm tokens (see AGENTS.md) — paper, ink, coral accent.
const BG = '#fbfaf7';
const INK = '#1a1a14';
const MUTED = '#75736a';
const FAINT = '#a8a6a0';
const CORAL = '#e85a4a';

const BRAND = 'TeamClu';

/**
 * `order` decides the PH upload slot; `src` is relative to the repo root.
 * `optional: true` scenes are skipped with a TODO when the source is missing
 * (they are the shots that still need to be captured from the running app).
 */
const SCENES = [
  {
    order: 1,
    slug: 'workspace',
    src: 'images/home.png',
    headline: 'Your team and its agents, one workspace',
    sub: 'Sessions, Knowledge, Skills and Apps side by side',
  },
  {
    order: 2,
    slug: 'team-skills',
    src: 'producthunt-kit/src/team-skills.png',
    optional: true,
    headline: 'Skills your whole team shares',
    sub: 'Publish once — every teammate\u2019s agent follows the new version',
  },
  {
    order: 3,
    slug: 'channels',
    src: 'images/channel.png',
    headline: 'Meet your agents where you already talk',
    sub: 'WeCom, Feishu, Discord, KOOK, WeChat and Email gateways',
  },
  {
    order: 4,
    slug: 'group-session',
    src: 'producthunt-kit/src/group-session.png',
    optional: true,
    headline: 'Sessions are group chats',
    sub: 'Teammates and agents in one thread — @mention an agent, it answers as a participant',
  },
  {
    order: 5,
    slug: 'extension',
    src: 'listing-kit/screenshots/01-side-panel-chat.png',
    headline: 'Agents in your browser side panel',
    sub: 'Chrome MV3 extension — chat without leaving the page',
  },
];

function run(args) {
  return execFileSync(MAGICK, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function dimensions(file) {
  const [w, h] = run(['identify', '-format', '%w %h', file]).trim().split(/\s+/).map(Number);
  return { w, h };
}

/** Rounded corners, the standard ImageMagick 7 mask recipe. */
function roundCorners(src, w, h, dest) {
  run([
    src,
    '-resize',
    `${w}x${h}!`,
    '-alpha',
    'set',
    '(',
    '+clone',
    '-alpha',
    'extract',
    '-draw',
    `fill black polygon 0,0 0,${RADIUS} ${RADIUS},0 fill white circle ${RADIUS},${RADIUS} ${RADIUS},0`,
    '(',
    '+clone',
    '-flip',
    ')',
    '-compose',
    'Multiply',
    '-composite',
    '(',
    '+clone',
    '-flop',
    ')',
    '-compose',
    'Multiply',
    '-composite',
    ')',
    '-alpha',
    'off',
    '-compose',
    'CopyOpacity',
    '-composite',
    dest,
  ]);
}

function addShadow(src, dest) {
  run([
    src,
    '(',
    '+clone',
    '-background',
    'black',
    '-shadow',
    '22x9+0+10',
    ')',
    '+swap',
    '-background',
    'none',
    '-layers',
    'merge',
    '+repage',
    dest,
  ]);
}

function composeFrame(scene, cardX, card, dest) {
  run([
    '-size',
    `${W}x${H}`,
    `xc:${BG}`,
    // Coral accent bar, aligned to the headline's cap height.
    '-fill',
    CORAL,
    '-draw',
    'rectangle 56,62 64,98',
    '-font',
    FONT_BOLD,
    '-pointsize',
    '44',
    '-fill',
    INK,
    '-gravity',
    'NorthWest',
    '-annotate',
    '+88+98',
    scene.headline,
    '-font',
    FONT_REGULAR,
    '-pointsize',
    '22',
    '-fill',
    MUTED,
    '-gravity',
    'NorthWest',
    '-annotate',
    '+88+142',
    scene.sub,
    '-font',
    FONT_BOLD,
    '-pointsize',
    '24',
    '-fill',
    FAINT,
    '-gravity',
    'NorthEast',
    '-annotate',
    '+56+64',
    BRAND,
    card,
    '-gravity',
    'NorthWest',
    '-geometry',
    `+${cardX}+${CARD_TOP}`,
    '-composite',
    dest,
  ]);
}

function main() {
  try {
    run(['-version']);
  } catch {
    console.error(`✗ \`${MAGICK}\` not found. Install ImageMagick: brew install imagemagick`);
    process.exit(1);
  }

  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });

  let built = 0;
  const missingOptional = [];
  const scenes = [...SCENES].sort((a, b) => a.order - b.order);

  for (const scene of scenes) {
    const src = path.join(ROOT, scene.src);
    if (!existsSync(src)) {
      if (scene.optional) {
        missingOptional.push(scene);
        console.warn(`• TODO  slot ${scene.order} (${scene.slug}) — capture ${scene.src}`);
        continue;
      }
      console.error(`✗ required source missing: ${scene.src}`);
      process.exit(1);
    }

    const { w: sw, h: sh } = dimensions(src);
    const scale = Math.min(CARD_MAX_W / sw, CARD_MAX_H / sh);
    const w = Math.round(sw * scale);
    const h = Math.round(sh * scale);
    const cardX = Math.round((W - w) / 2);

    const rounded = path.join(TMP_DIR, `${scene.slug}-rounded.png`);
    const card = path.join(TMP_DIR, `${scene.slug}-card.png`);
    const out = path.join(OUT_DIR, `ph-${scene.order}-${scene.slug}-1270x760.png`);

    roundCorners(src, w, h, rounded);
    addShadow(rounded, card);
    composeFrame(scene, cardX, card, out);

    const { w: ow, h: oh } = dimensions(out);
    if (ow !== W || oh !== H) {
      console.error(`✗ ${path.basename(out)} is ${ow}×${oh}, expected ${W}×${H}`);
      process.exit(1);
    }
    console.log(`✓ slot ${scene.order}  ${path.relative(ROOT, out)}  (card ${w}×${h})`);
    built += 1;
  }

  // Square logo for the post thumbnail — PH crops it to a circle.
  const logo = path.join(ROOT, 'images/logo.jpg');
  if (existsSync(logo)) {
    for (const size of [512, 240]) {
      const out = path.join(OUT_DIR, `thumbnail-${size}.png`);
      run([logo, '-resize', `${size}x${size}!`, out]);
      console.log(`✓ ${path.relative(ROOT, out)}`);
      built += 1;
    }
  }

  rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`\n${built} asset(s) in ${path.relative(ROOT, OUT_DIR)}/`);
  if (missingOptional.length > 0) {
    console.log(
      `\n${missingOptional.length} team-story slot(s) still empty — see producthunt-kit/src/README.md`,
    );
  }
}

main();
