import { mqttSubscribe, mqttUnsubscribe } from "@/lib/mqtt-bridge";

export const subscribedSessionTopics = new Set<string>();

const pendingSessionSubscriptions = new Map<string, Promise<void>>();
let subscriptionEpoch = 0;

let interestTeamId: string | null = null;
let interestSessionIds = new Set<string>();
let syncInterestEpoch = 0;
/** Serializes sync runs so a slow release cannot interleave with a newer sync. */
let syncInterestChain: Promise<void> = Promise.resolve();

function sessionLiveTopic(teamId: string, sessionId: string): string {
  return `amux/${teamId}/session/${sessionId}/live`;
}

function isSyncEpochCurrent(epoch: number): boolean {
  return syncInterestEpoch === epoch;
}

/** TeamClu cloud session ids that must keep session/live SUB (streaming or pending approval). */
export function collectSessionsNeedingLiveInterest(
  byKey: Record<string, {
    sessionId: string;
    active: boolean;
    pendingPermissionsByRequestId: Record<string, unknown>;
  }>,
): string[] {
  const ids = new Set<string>();
  for (const entry of Object.values(byKey)) {
    if (!entry.sessionId.trim()) continue;
    if (entry.active || Object.keys(entry.pendingPermissionsByRequestId).length > 0) {
      ids.add(entry.sessionId.trim());
    }
  }
  return [...ids].filter(Boolean);
}

/** Mark session as live-interest before SUB so handlers accept events immediately. */
function noteSessionLiveInterest(teamId: string, sessionId: string): void {
  const trimmed = sessionId.trim();
  if (!trimmed) return;
  if (interestTeamId !== null && interestTeamId !== teamId) return;
  interestTeamId = teamId;
  interestSessionIds.add(trimmed);
}

export async function ensureSessionLiveSubscribed(
  teamId: string,
  sessionId: string,
): Promise<void> {
  const trimmed = sessionId.trim();
  if (!trimmed) return;

  // Same ordering as syncSessionLiveInterest — accept events (incl. local SSE)
  // while the broker SUB is still in flight.
  noteSessionLiveInterest(teamId, trimmed);

  const topic = sessionLiveTopic(teamId, trimmed);
  while (true) {
    if (subscribedSessionTopics.has(topic)) return;
    const pending = pendingSessionSubscriptions.get(topic);
    if (pending) {
      await pending;
      continue;
    }

    const epoch = subscriptionEpoch;
    const subscription = mqttSubscribe(topic);
    pendingSessionSubscriptions.set(topic, subscription);
    try {
      await subscription;
    } finally {
      if (pendingSessionSubscriptions.get(topic) === subscription) {
        pendingSessionSubscriptions.delete(topic);
      }
    }
    if (subscriptionEpoch === epoch) {
      subscribedSessionTopics.add(topic);
      return;
    }
  }
}

export function isSessionLiveInterest(sessionId: string): boolean {
  return interestSessionIds.has(sessionId);
}

async function runSyncSessionLiveInterest(
  teamId: string | null,
  sessionIds: readonly string[],
): Promise<void> {
  const epoch = ++syncInterestEpoch;
  const nextIds = new Set(sessionIds.map((id) => id.trim()).filter(Boolean));

  if (!teamId || nextIds.size === 0) {
    const topicsToRelease = interestTeamId ? [...subscribedSessionTopics] : [];
    for (const topic of topicsToRelease) {
      if (!isSyncEpochCurrent(epoch)) return;
      try {
        await mqttUnsubscribe(topic);
      } catch (error) {
        console.warn("[MQTT] unsubscribe session/live topic failed", { topic, error });
      }
      if (!isSyncEpochCurrent(epoch)) return;
      subscribedSessionTopics.delete(topic);
    }
    if (!isSyncEpochCurrent(epoch)) return;
    interestTeamId = null;
    interestSessionIds.clear();
    return;
  }

  const desiredTopics = new Set(
    [...nextIds].map((sessionId) => sessionLiveTopic(teamId, sessionId)),
  );

  for (const topic of [...subscribedSessionTopics]) {
    if (desiredTopics.has(topic)) continue;
    if (!isSyncEpochCurrent(epoch)) return;
    try {
      await mqttUnsubscribe(topic);
    } catch (error) {
      console.warn("[MQTT] unsubscribe session/live topic failed", { topic, error });
    }
    if (!isSyncEpochCurrent(epoch)) return;
    subscribedSessionTopics.delete(topic);
  }

  if (!isSyncEpochCurrent(epoch)) return;

  // Update before SUB so MqttLiveWiring accepts live events (incl. local SSE)
  // while subscriptions are still in flight.
  interestTeamId = teamId;
  interestSessionIds = nextIds;

  await Promise.all(
    [...nextIds].map((sessionId) => ensureSessionLiveSubscribed(teamId, sessionId)),
  );
}

/** Keep MQTT session/live SUB aligned with foreground + background TeamClu sessions. */
export async function syncSessionLiveInterest(
  teamId: string | null,
  sessionIds: readonly string[],
): Promise<void> {
  syncInterestChain = syncInterestChain
    .then(() => runSyncSessionLiveInterest(teamId, sessionIds))
    .catch((error) => {
      console.warn("[MQTT] sync session/live interest failed", error);
    });
  await syncInterestChain;
}

/** After {@link resetSessionLiveSubscriptionState} on reconnect, re-SUB the interest set. */
export async function resubscribeSessionLiveInterest(): Promise<void> {
  const teamId = interestTeamId;
  const sessionIds = [...interestSessionIds];
  if (!teamId || sessionIds.length === 0) return;
  await Promise.all(
    sessionIds.map((sessionId) => ensureSessionLiveSubscribed(teamId, sessionId)),
  );
}

export function resetSessionLiveSubscriptionState(): void {
  subscriptionEpoch += 1;
  subscribedSessionTopics.clear();
  pendingSessionSubscriptions.clear();
}

export const resetSessionLiveSubscriptionStateForTests = resetSessionLiveSubscriptionState;

export function resetSessionLiveInterestForTests(): void {
  syncInterestEpoch += 1;
  interestTeamId = null;
  interestSessionIds.clear();
  syncInterestChain = Promise.resolve();
}

/** 1h without session/live activity → inbox-triggered SUB may be released. */
export const SESSION_LIVE_IDLE_UNSUB_MS = 60 * 60 * 1000;
/** Periodic sweep for expired inbox-triggered interest. */
export const SESSION_LIVE_IDLE_SWEEP_MS = 5 * 60 * 1000;

const inboxOpenedAt = new Map<string, number>();
const lastLiveEventAt = new Map<string, number>();
let inboxIdleSweepTimer: ReturnType<typeof setInterval> | null = null;

function lastInboxSessionActivityAt(sessionId: string): number {
  return lastLiveEventAt.get(sessionId) ?? inboxOpenedAt.get(sessionId) ?? 0;
}

/** Inbox message ping → SUB session/live; clock starts at open until first live event. */
export function noteInboxOpenedSession(sessionId: string, now = Date.now()): boolean {
  const sid = sessionId.trim();
  if (!sid) return false;
  const isNew = !inboxOpenedAt.has(sid);
  if (isNew) inboxOpenedAt.set(sid, now);
  return isNew;
}

/** Renew idle deadline when a subscribed session receives session/live traffic. */
export function touchLiveEventActivity(sessionId: string, now = Date.now()): void {
  const sid = sessionId.trim();
  if (!sid || !inboxOpenedAt.has(sid)) return;
  lastLiveEventAt.set(sid, now);
}

/** Inbox-opened sessions still within the idle window (excluding pinned). */
export function collectInboxIdleInterestSessionIds(
  pinnedIds: ReadonlySet<string>,
  now = Date.now(),
): string[] {
  const out: string[] = [];
  for (const sid of inboxOpenedAt.keys()) {
    if (pinnedIds.has(sid)) continue;
    if (now - lastInboxSessionActivityAt(sid) <= SESSION_LIVE_IDLE_UNSUB_MS) {
      out.push(sid);
    }
  }
  return out;
}

/** Drop expired inbox-opened sessions; returns true when the interest set may have shrunk. */
export function pruneIdleInboxSessions(
  pinnedIds: ReadonlySet<string>,
  now = Date.now(),
): boolean {
  let changed = false;
  for (const sid of [...inboxOpenedAt.keys()]) {
    if (pinnedIds.has(sid)) continue;
    if (now - lastInboxSessionActivityAt(sid) > SESSION_LIVE_IDLE_UNSUB_MS) {
      inboxOpenedAt.delete(sid);
      lastLiveEventAt.delete(sid);
      changed = true;
    }
  }
  return changed;
}

/** Foreground + streaming/approval + non-idle inbox-opened sessions. */
export function mergeSessionLiveInterestIds(
  activeSessionId: string | null,
  backgroundIds: readonly string[],
  now = Date.now(),
): string[] {
  const pinned = new Set<string>();
  const trimmedActive = activeSessionId?.trim();
  if (trimmedActive) pinned.add(trimmedActive);
  for (const id of backgroundIds) {
    const trimmed = id.trim();
    if (trimmed) pinned.add(trimmed);
  }
  const inboxIdle = collectInboxIdleInterestSessionIds(pinned, now);
  return [...new Set([...pinned, ...inboxIdle])];
}

export function startInboxIdleSweep(onSweep: () => void): void {
  stopInboxIdleSweep();
  inboxIdleSweepTimer = setInterval(onSweep, SESSION_LIVE_IDLE_SWEEP_MS);
}

export function stopInboxIdleSweep(): void {
  if (inboxIdleSweepTimer) {
    clearInterval(inboxIdleSweepTimer);
    inboxIdleSweepTimer = null;
  }
}

export function resetInboxIdleInterestState(): void {
  stopInboxIdleSweep();
  inboxOpenedAt.clear();
  lastLiveEventAt.clear();
}

export const resetInboxIdleInterestForTests = resetInboxIdleInterestState;
