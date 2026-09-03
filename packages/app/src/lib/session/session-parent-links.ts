import type { Session } from "@/stores/session-types";

/** Minimal session shape needed to resolve child→parent activity owners. */
type SessionParentLink = Pick<Session, "id" | "parentID">;

export function selectSessionParentLinks(
  sessions: ReadonlyArray<Pick<Session, "id" | "parentID">>,
): SessionParentLink[] {
  return sessions.map((session) => ({
    id: session.id,
    parentID: session.parentID,
  }));
}

export function sessionParentLinksEqual(
  a: ReadonlyArray<SessionParentLink>,
  b: ReadonlyArray<SessionParentLink>,
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].parentID !== b[i].parentID) return false;
  }
  return true;
}
