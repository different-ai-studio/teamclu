/**
 * The 1920×1080 Editorial Calm poster layout, shared by every topic in
 * `posterkit/topics/`.
 *
 * Structure (mirrors videokit so the two read as one set):
 *
 *   eyebrow ────────────────────────────────────────── TeamClu
 *   ▌ CLAIM line 1
 *     CLAIM line 2
 *     sub
 *   ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
 *   │ card   │ │ card   │ │ card   │ │ card   │   4 across, equal height
 *   └────────┘ └────────┘ └────────┘ └────────┘
 *   ──────────────────────────────────────────────────
 *   NOT BUILT …                              teamclu.ai
 *
 * Topics supply only copy. Every number and mechanism in a topic must be
 * traceable to `docs/features/` — a poster is a claim, and a claim you cannot
 * defend in the comments is a liability.
 */
export const W = 1920;
export const H = 1080;

// ── Layout constants (authored against a 1080-tall canvas) ─────────────────
export const M = 200;              // side margin
export const CONTENT = W - M * 2;  // 1520
export const EYEBROW_Y = 118;      // top-left label line, and the bar aligns to it
export const CLAIM_SIZE = 62;
export const CLAIM_1_Y = 236;
export const CLAIM_2_Y = 306;
export const SUB_Y = 362;
export const CARD_Y = 406;
export const CARD_H = 440;
export const CARD_GAP = 20;
export const CARD_W = (CONTENT - CARD_GAP * 3) / 4;  // 365
export const CARD_PAD = 24;
export const CARD_INNER = CARD_W - CARD_PAD * 2;     // 317
export const BODY_Y = CARD_Y + 158;   // first body baseline
export const LINE_H = 30;             // body line height
export const PARA_GAP = 10;
export const RULE_Y = 880;
export const LABEL_Y = 916;
export const FOOT_Y = 950;

/**
 * The body budget, in wrapped lines, for a card. Enforced by the audit, because
 * the first skills poster shipped with card 3 running 2 lines past the card edge
 * and the audit — not a human eye — is what caught it.
 */
export const BODY_LINE_BUDGET = Math.floor((CARD_H - 158 - PARA_GAP * 2) / LINE_H) + 1; // 8

/**
 * @param {object} d        a design kit from kits/design.mjs
 * @param {object} topic    { eyebrow, claim1, claim2, sub, cards[], notBuilt, site }
 * @returns {string[]}      ImageMagick argument list (without the output path)
 */
export function renderPoster(d, topic) {
  const {
    T: { paper: PAPER, ink: INK, ink2: INK2, muted: MUTED, faint: FAINT, border: BORDER, coral: CORAL },
    F: { bold: FB, regular: FR },
    frame, roundRect, line, dot, text, textFit, textRight, ink: measure, wrap, accentBar,
  } = d;

  const parts = [
    ...frame(),

    // eyebrow + brand
    ...text(FR, 22, MUTED, topic.eyebrow, M, EYEBROW_Y),
    ...textRight(FB, 24, INK, 'TeamClu', W - M, EYEBROW_Y),

    // The coral mark sits BESIDE the eyebrow, vertically centred on it — it is
    // the marker for the whole poster, so it belongs to the top-left line, not
    // floating above the claim. Two earlier attempts were wrong: hanging 40px
    // left of the text broke the left margin (bar, eyebrow and claim sat on
    // three different left edges), and putting it on the margin above the claim
    // put it under the eyebrow instead of beside anything.
    ...accentBar(EYEBROW_Y, 22, { x: M - 36, height: 32, font: FR, align: 'center' }),

    // the claim
    ...textFit(FB, CLAIM_SIZE, INK, topic.claim1, M, CLAIM_1_Y, CONTENT),
    ...textFit(FB, CLAIM_SIZE, INK, topic.claim2, M, CLAIM_2_Y, CONTENT),
    ...textFit(FR, 30, MUTED, topic.sub, M, SUB_Y, CONTENT),
  ];

  if (topic.cards.length !== 4) {
    throw new Error(`expected 4 cards (the row is laid out as four), got ${topic.cards.length}`);
  }

  topic.cards.forEach((c, i) => {
    const x = M + i * (CARD_W + CARD_GAP);
    const inner = CARD_INNER;
    const lx = x + CARD_PAD;
    const rx = x + CARD_W - CARD_PAD;

    parts.push(...roundRect(x, CARD_Y, CARD_W, CARD_H, 14, BORDER, 1.5, PAPER));
    parts.push(...text(FB, 19, MUTED, c.label, lx, CARD_Y + 42));
    parts.push(...textFit(FB, 27, INK, c.title, lx, CARD_Y + 96, inner));
    parts.push(...line(lx, CARD_Y + 120, rx, CARD_Y + 120, BORDER, 1));

    let y = BODY_Y;

    // Optional segment list, e.g. the six publish-gate fields. A `hi` segment is
    // marked with a coral dot placed directly against THAT token — an earlier
    // version put the dot at the line start, where it read as labelling the
    // first token instead.
    if (c.lead) {
      c.lead.forEach((segs) => {
        let sx = lx;
        segs.forEach((seg, si) => {
          if (si > 0) {
            parts.push(...text(FR, 20, FAINT, '\u00b7', sx, y));
            sx += measure('\u00b7', FR, 20).w + 7;
          }
          if (seg.hi) {
            parts.push(...dot(sx + 3, y - 7, 3, CORAL));
            sx += 12;
          }
          parts.push(...text(FR, 20, seg.hi ? INK : INK2, seg.t, sx, y));
          sx += measure(seg.t, FR, 20).w;
        });
        if (sx - lx > inner) {
          d.notes.push(`card ${i + 1} (${c.label}) lead line overruns by ${Math.round(sx - lx - inner)}px`);
        }
        y += 28;
      });
      y += 14;
      // divider clear of the next paragraph's cap line; at y-18 it nearly touched
      parts.push(...line(lx, y - 26, rx, y - 26, BORDER, 1));
    }

    const paras = c.note ? [c.note] : c.body;
    let used = 0;
    paras.forEach((para, pi) => {
      if (pi > 0) y += PARA_GAP;
      const lines = wrap(para, FR, 21, inner);
      used += lines.length;
      lines.forEach((ln) => {
        parts.push(...textFit(FR, 21, INK2, ln, lx, y, inner));
        y += LINE_H;
      });
    });

    if (used > BODY_LINE_BUDGET) {
      d.notes.push(`card ${i + 1} (${c.label}) body is ${used} lines, budget ${BODY_LINE_BUDGET}`);
    }
    if (y > CARD_Y + CARD_H - 10) {
      d.notes.push(`card ${i + 1} (${c.label}) body overruns the card by ${Math.round(y - (CARD_Y + CARD_H))}px`);
    }
  });

  // footer: the honest edge, then the site
  parts.push(...line(M, RULE_Y, W - M, RULE_Y, BORDER, 1));
  parts.push(...text(FB, 20, MUTED, 'NOT BUILT', M, LABEL_Y));
  topic.notBuilt.forEach((t, i) => {
    parts.push(...textFit(FR, 22, INK2, t, M, FOOT_Y + i * 30, CONTENT - 260));
  });
  parts.push(...textRight(FR, 22, FAINT, topic.site, W - M, FOOT_Y));
  parts.push(...textRight(FR, 18, FAINT, 'MIT \u00b7 in beta', W - M, FOOT_Y + 28));

  return parts;
}
