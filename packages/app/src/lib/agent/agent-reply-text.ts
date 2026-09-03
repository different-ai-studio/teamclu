/** Normalize agent reply bodies for equivalence checks (acp.output vs message.created). */
export function normalizeAgentReplyText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Prefer the longer body when two texts are equivalent after normalization. */
export function pickCanonicalAgentReplyText(a: string, b: string): string {
  if (agentReplyTextsEquivalent(a, b)) {
    return a.length >= b.length ? a : b;
  }
  return b.length >= a.length ? b : a;
}

/**
 * True when two reply bodies represent the same user-visible content.
 * Handles whitespace drift between acp.output deltas and message.created content.
 */
export function agentReplyTextsEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  const na = normalizeAgentReplyText(a);
  const nb = normalizeAgentReplyText(b);
  if (!na && !nb) return true;
  if (!na || !nb) return false;
  if (na === nb) return true;

  const longer = na.length >= nb.length ? na : nb;
  const shorter = na.length >= nb.length ? nb : na;
  if (!longer.startsWith(shorter)) return false;

  const tail = longer.slice(shorter.length);
  // Only whitespace / light punctuation drift (acp.output vs message.created).
  return /^[\s.,;:!?、。，；：！？…]*$/.test(tail);
}

/**
 * True when acp.output and message.created are the same reply with minor
 * mid-body drift (e.g. 改、 vs 改改) that fails prefix-only equivalence.
 */
export function agentReplyBodiesCollapsible(a: string, b: string): boolean {
  if (agentReplyTextsEquivalent(a, b)) return true;
  const na = normalizeAgentReplyText(a);
  const nb = normalizeAgentReplyText(b);
  if (!na || !nb) return false;

  const minLen = Math.min(na.length, nb.length);
  const maxLen = Math.max(na.length, nb.length);
  if (minLen < 20) return false;
  if (maxLen - minLen > Math.max(8, Math.floor(maxLen * 0.05))) return false;

  const prefixLen = Math.min(40, minLen - 1);
  return na.slice(0, prefixLen) === nb.slice(0, prefixLen);
}
