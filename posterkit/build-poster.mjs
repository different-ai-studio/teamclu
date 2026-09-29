#!/usr/bin/env node
/**
 * Build the TeamClu feature poster for Skills management — 1920×1080, English.
 *
 *   node posterkit/build-poster.mjs
 *
 * ## The claim
 *
 * One sentence, not a feature list:
 *
 *   A skill is not a prompt fragment. It is a team asset you can own, version,
 *   and audit.
 *
 * That is docs/features/06-skills-roles-marketplace.md §0, verbatim in spirit:
 * "skill 不是「给 agent 的提示词片段」，而是「团队可以拥有、版本化、审计的资产」".
 * Everything below it is a mechanism that makes the claim true, and every number
 * is traceable:
 *
 *   6 required fields, `when_not_to_use` decisive      06 §4
 *   append-only versions, changelog required           06 §3.1
 *   10-minute background reconcile, no update button   06 §6.1
 *   dirty edits become conflicts, never silent loss    06 §6.4
 *
 * The footer prints one thing that is NOT built. That is deliberate: it is the
 * same disclosure the PH FAQ already makes (06 §1.3 — one key per team, shared
 * by all members; it protects against the cloud provider, not against
 * colleagues). A poster that only claims strengths is less credible than one
 * that states its edge, and "any team member can publish; owner is
 * responsibility, not permission" (06 §3.3) is counterintuitive enough to be
 * worth stating outright.
 *
 * Deliberately NOT on the poster: Roles, the marketplace, the permission panel.
 * 06 §9 says a role is "一组 skill 的命名组合" and follows the skill mechanism, so
 * it is not a separate pillar.
 *
 * Requires ImageMagick (brew install imagemagick).
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesign } from '../kits/design.mjs';

const KIT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(KIT, 'out');
const NAME = 'skills-management';

const W = 1920;
const H = 1080;
const MAGICK = process.env.MAGICK || 'magick';

const d = createDesign({ width: W, height: H, magick: MAGICK });
const {
  T: { paper: PAPER, ink: INK, ink2: INK2, muted: MUTED, faint: FAINT, border: BORDER, coral: CORAL },
  F: { bold: FONT_BOLD, regular: FONT_REGULAR },
  notes, frame, roundRect, line, dot, text, textFit, textRight, ink: measure, wrap, accentBar,
} = d;

// ── Layout (authored against a 1080-tall canvas) ───────────────────────────
const M = 200;                 // side margin
const CONTENT = W - M * 2;     // 1520
const CLAIM_SIZE = 62;
const CARD_Y = 406;
const CARD_H = 440;
const CARD_GAP = 20;
const CARD_W = (CONTENT - CARD_GAP * 3) / 4;   // 365
const CARD_PAD = 24;
const CARD_INNER = CARD_W - CARD_PAD * 2;      // 317

const CARDS = [
  {
    label: 'PUBLISH GATE',
    title: 'Six required fields',
    // Segment arrays so the decisive field can be marked on its own token rather
    // than at the start of a line, where the dot reads as labelling the line.
    lead: [
      [{ t: 'owner' }, { t: 'summary' }, { t: 'category' }],
      [{ t: 'when_to_use' }, { t: 'when_not_to_use', hi: true }],
      [{ t: 'changelog' }],
    ],
    // 06 §4: two skills with overlapping jobs can only sit side by side if their
    // boundaries are written down. This is the field the design hinges on.
    note: 'when_not_to_use is the one that matters. Overlapping skills can only sit side by side if their boundaries are written down.',
  },
  {
    label: 'VERSION HISTORY',
    title: 'Append-only',
    body: [
      'Every release requires a changelog.',
      'Old content is never edited in place. Revert re-publishes it as latest + 1.',
      'So \u201cwho changed what\u201d has a record, not a memory.',
    ],
  },
  {
    label: 'AUTO-FOLLOW',
    title: 'No update button',
    // Trimmed to 8 wrapped lines: the card body starts at +158 and the card is
    // 440 tall, so 8 lines (240px) plus the two 10px paragraph gaps is the
    // budget. The first draft ran to 10 lines and the audit caught the overrun.
    body: [
      'Installed skills track latest_version on a 10-minute background reconcile.',
      'No button to click. No \u201cplease update your skill\u201d messages.',
      'The interval is deliberate: skills ship as zips, so a lazy refresh would tax every agent start.',
    ],
  },
  {
    label: 'CONFLICTS',
    title: 'No silent overwrites',
    body: [
      'A local edit is never silently overwritten by the automatic follow.',
      'It becomes a conflict for a human to resolve.',
      'Automatic follow without this would just be data loss.',
    ],
  },
];

const CLAIM_1 = 'A skill is not a prompt fragment.';
const CLAIM_2 = 'It is a team asset you can own, version, and audit.';
const SUB = 'The TeamClu skills registry \u2014 and the four mechanisms that make that true.';

const NOT_BUILT_LABEL = 'NOT BUILT';
const NOT_BUILT = [
  'Per-member skill visibility. One key per team, shared by all members \u2014 it protects against the cloud',
  'provider, not against colleagues. And any team member can publish: owner is responsibility, not permission.',
];

// ── Render ─────────────────────────────────────────────────────────────────
const parts = [
  ...frame(),

  // eyebrow + brand
  ...text(FONT_REGULAR, 22, MUTED, 'SKILLS MANAGEMENT', M, 118),
  ...textRight(FONT_BOLD, 24, INK, 'TeamClu', W - M, 118),

  // the claim. The accent bar hangs left, its bottom edge on the cap line.
  ...accentBar(236, CLAIM_SIZE, { x: M - 40 }),
  ...textFit(FONT_BOLD, CLAIM_SIZE, INK, CLAIM_1, M, 236, CONTENT),
  ...textFit(FONT_BOLD, CLAIM_SIZE, INK, CLAIM_2, M, 306, CONTENT),
  ...textFit(FONT_REGULAR, 30, MUTED, SUB, M, 362, CONTENT),
];

CARDS.forEach((c, i) => {
  const x = M + i * (CARD_W + CARD_GAP);
  const inner = CARD_INNER;
  const lx = x + CARD_PAD;
  const ly = CARD_Y;
  const rx = x + CARD_W - CARD_PAD;

  parts.push(...roundRect(x, ly, CARD_W, CARD_H, 14, BORDER, 1.5, PAPER));
  parts.push(...text(FONT_BOLD, 19, MUTED, c.label, lx, ly + 42));
  parts.push(...textFit(FONT_BOLD, 27, INK, c.title, lx, ly + 96, inner));
  parts.push(...line(lx, ly + 120, rx, ly + 120, BORDER, 1));

  let y = ly + 158;

  if (c.lead) {
    c.lead.forEach((segs) => {
      let sx = lx;
      segs.forEach((seg, si) => {
        if (si > 0) {
          parts.push(...text(FONT_REGULAR, 20, FAINT, '\u00b7', sx, y));
          sx += measure('\u00b7', FONT_REGULAR, 20).w + 7;
        }
        if (seg.hi) {
          // coral dot sits directly against the token it marks
          parts.push(...dot(sx + 3, y - 7, 3, CORAL));
          sx += 12;
        }
        parts.push(...text(FONT_REGULAR, 20, seg.hi ? INK : INK2, seg.t, sx, y));
        sx += measure(seg.t, FONT_REGULAR, 20).w;
      });
      if (sx - lx > inner) notes.push(`card ${i + 1} lead line overruns by ${Math.round(sx - lx - inner)}px`);
      y += 28;
    });
    y += 14;
    // divider clear of the note's cap line — at y-18 it nearly touched it
    parts.push(...line(lx, y - 26, rx, y - 26, BORDER, 1));
  }

  const source = c.note ? [c.note] : c.body;
  source.forEach((para, pi) => {
    if (pi > 0) y += 10;
    wrap(para, FONT_REGULAR, 21, inner).forEach((ln) => {
      parts.push(...textFit(FONT_REGULAR, 21, INK2, ln, lx, y, inner));
      y += 30;
    });
  });

  if (y > ly + CARD_H - 10) {
    notes.push(`card ${i + 1} (${c.label}) body overruns by ${Math.round(y - (ly + CARD_H))}px`);
  }
});

// footer: the honest edge, then the site
parts.push(...line(M, 880, W - M, 880, BORDER, 1));
parts.push(...text(FONT_BOLD, 20, MUTED, NOT_BUILT_LABEL, M, 916));
NOT_BUILT.forEach((t, i) => {
  parts.push(...textFit(FONT_REGULAR, 22, INK2, t, M, 950 + i * 30, CONTENT - 260));
});
parts.push(...textRight(FONT_REGULAR, 22, FAINT, 'teamclu.ai', W - M, 950));
parts.push(...textRight(FONT_REGULAR, 18, FAINT, 'MIT \u00b7 in beta', W - M, 978));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const dest = path.join(OUT, `${NAME}-1920x1080.png`);

// -strip: ImageMagick stamps date:create / date:modify into every output, so
// without it two identical runs produce different bytes and `git status` goes
// dirty on a diff that shows nothing. (Same reason as the gallery script.)
d.run([...parts, '-strip', dest]);

const dims = d.run(['identify', '-format', '%wx%h', dest]).trim();
process.stdout.write(`built ${path.relative(path.dirname(KIT), dest)}  ${dims}\n`);
if (notes.length) {
  process.stdout.write(`\n${notes.length} layout note(s):\n${notes.map((n) => `  - ${n}`).join('\n')}\n`);
} else {
  process.stdout.write('layout audit: no overflow, nothing shrunk to fit\n');
}
if (!existsSync(dest)) process.exit(1);
