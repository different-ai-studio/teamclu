import type { SessionSummary } from "./session-types";

/**
 * The summary of a session the list just opened, for the detail screen's first
 * frame. The detail screen used to show a full-screen "Loading session" card
 * until its own disk read landed, though the list had the title, avatars and
 * member count in hand at the tap. Handing them over lets the header and the
 * composer paint at once, and the transcript fills in underneath.
 */
const summaries = new Map<string, SessionSummary>();
const MAX_REMEMBERED = 20;

export function rememberOpeningSession(summary: SessionSummary): void {
  summaries.delete(summary.sessionId);
  summaries.set(summary.sessionId, summary);
  while (summaries.size > MAX_REMEMBERED) {
    const oldest = summaries.keys().next().value;
    if (oldest === undefined) break;
    summaries.delete(oldest);
  }
}

export function openingSession(sessionId: string): SessionSummary | null {
  return summaries.get(sessionId) ?? null;
}
