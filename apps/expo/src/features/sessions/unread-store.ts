type Listener = (count: number) => void;

let count = 0;
let activeTeamId: string | null = null;
/** Whether the active team's list has reported a count since it became active. */
let reported = false;
const listeners = new Set<Listener>();
const reportListeners = new Set<Listener>();

function publish(next: number) {
  if (next === count) return;
  count = next;
  for (const listener of listeners) listener(count);
}

/**
 * Process-local unread session counter. Written by the Sessions
 * controller whenever a list load resolves (so it stays in sync with
 * the rows the user sees), read by the tabs layout to drive the
 * Sessions tab's badge. Lives outside React state so cross-tree
 * subscribers don't have to share a context.
 *
 * `teamId` names the team the count was computed for. Once an active
 * team is set, a count for any other team is dropped: after a team
 * switch the previous team's controller can still have a request in
 * flight, and its answer must not badge the new team's tab.
 */
export function setUnreadSessionCount(next: number, teamId?: string | null) {
  if (teamId != null && activeTeamId !== null && teamId !== activeTeamId) return;
  reported = true;
  publish(next);
  for (const listener of reportListeners) listener(count);
}

/**
 * Declare which team the badge belongs to. Changing it zeroes the count
 * until the new team's list reports — the old team's unread number is
 * about sessions the user can no longer see.
 */
export function setActiveUnreadTeam(teamId: string | null) {
  if (teamId === activeTeamId) return;
  activeTeamId = teamId;
  reported = false;
  publish(0);
}

export function getUnreadSessionCount(): number {
  return count;
}

/**
 * True once the active team's list (cache or network) has reported. Before
 * that the count's 0 means "not known yet", not "nothing unread" — the app
 * icon badge must not act on it (it would clear Notification Center).
 */
export function hasUnreadSessionCountReport(): boolean {
  return reported;
}

/**
 * Called on every accepted report, even one that repeats the last count —
 * unlike `subscribeUnreadSessionCount`, which only fires on a change.
 */
export function subscribeUnreadSessionCountReports(listener: Listener): () => void {
  reportListeners.add(listener);
  return () => {
    reportListeners.delete(listener);
  };
}

export function subscribeUnreadSessionCount(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
