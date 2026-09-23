// services/fc/lib/push-dispatch.mjs
import { inDnd, isForegroundDevice, truncate } from './push-filters.js';

/** Payload version on `<agent>/inbox`. Bump when the shape changes. */
const AGENT_INBOX_PAYLOAD_VERSION = 1;

/**
 * Deliver a message to every agent participant's own inbox topic.
 *
 * This is the agent's *only* delivery path (#1455 Phase 1): a daemon no longer
 * subscribes to `session/<sid>/live` to hear inbound messages, so a publish
 * that does not happen here is a message the agent never sees until its next
 * reconcile.
 *
 * Two consequences for the code below:
 *
 *  - It runs BEFORE `push_idempotency_claim`. That claim exists to stop a
 *    duplicate APNs alert; letting it gate this path would mean a retried or
 *    re-entered dispatch silently skips the agent. Re-publishing is harmless
 *    the other way round — the daemon dedups on `message_id`.
 *  - Failures are logged with the ids needed to chase them, not swallowed
 *    quietly. The daemon's reconcile-on-connect is the backstop, but a silent
 *    failure here is indistinguishable from "nobody was mentioned".
 *
 * The payload carries the whole `amux.messages` row. Trace bodies stay out of
 * MQTT: `metadata.trace` is a pointer into OSS (§7.2) and the agent fetches it
 * on demand.
 */
export async function publishAgentInbox(msg, deps) {
  const { sb, mqtt } = deps;
  if (!mqtt) return { skipped: 'no_mqtt' };
  if (msg.kind === 'system') return { skipped: 'system_kind' };
  if (!msg.team_id) return { skipped: 'no_team_id' };

  let agentActorIds;
  try {
    agentActorIds = await sb.listSessionAgentActorIds(msg.session_id, msg.sender_actor_id ?? null);
  } catch (err) {
    console.error('[fanout] agent participant lookup failed', {
      messageId: msg.id, sessionId: msg.session_id, error: String(err),
    });
    return { failed: 'lookup', targets: 0, sent: 0 };
  }
  if (agentActorIds.length === 0) return { targets: 0, sent: 0 };

  const payload = JSON.stringify({
    v: AGENT_INBOX_PAYLOAD_VERSION,
    type: 'message.created',
    message: {
      id: msg.id,
      team_id: msg.team_id,
      session_id: msg.session_id,
      turn_id: msg.turn_id ?? null,
      sender_actor_id: msg.sender_actor_id ?? null,
      reply_to_message_id: msg.reply_to_message_id ?? null,
      kind: msg.kind ?? 'text',
      content: msg.content ?? '',
      metadata: msg.metadata ?? {},
      model: msg.model ?? null,
      created_at: msg.created_at ?? null,
    },
  });

  const results = await Promise.allSettled(
    agentActorIds.map((actorId) =>
      mqtt.publish(`amux/${msg.team_id}/${actorId}/inbox`, payload)),
  );

  let sent = 0;
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') { sent++; continue; }
    console.error('[fanout] agent inbox publish failed', {
      messageId: msg.id,
      sessionId: msg.session_id,
      agentActorId: agentActorIds[i],
      error: String(result.reason),
    });
  }
  return { targets: agentActorIds.length, sent, failed: agentActorIds.length - sent };
}

/**
 * Everything that happens after a message row lands: agent delivery first,
 * then the notification side-effects.
 *
 * `dispatchPush` stays a separate export because `/push/dispatch` (the admin
 * re-send endpoint) must NOT reach the agent inbox — re-sending a push would
 * otherwise re-trigger the agent's turn.
 */
export async function fanoutMessage(msg, deps) {
  const agentInbox = await publishAgentInbox(msg, deps);
  const push = await dispatchPush(msg, deps);
  return { ...push, agentInbox };
}

export async function dispatchPush(msg, deps) {
  const { id: messageId, session_id, sender_actor_id, kind, content } = msg;
  const { sb, apns, mqtt, now = () => new Date() } = deps;

  if (kind === 'system') return { skipped: 'system_kind' };

  // sb is the adapter built by push-deps.ts, not a Supabase client: its rpc()
  // already targets the amux schema. Calling sb.schema() here threw on every
  // dispatch, and the pg-backed deps could not satisfy it at all — they answer
  // rpc() from direct queries and have no schema() to offer.
  const claimRes = await sb.rpc('push_idempotency_claim', { p_message_id: messageId });
  const claimed = claimRes?.data?.[0]?.claimed ?? false;
  if (!claimed) return { skipped: 'duplicate' };

  const ctxRes = await sb.rpc('list_session_push_targets', {
    p_session_id: session_id, p_exclude_actor_id: sender_actor_id,
  });
  const ctx = ctxRes?.data ?? { recipients: [], sender_display_name: 'Someone' };

  const jobs = [];
  for (const r of ctx.recipients) {
    if (r.muted) continue;
    if (r.prefs && r.prefs.enabled === false) continue;
    if (inDnd(r.prefs, now())) continue;
    for (const t of r.tokens) {
      if (t.provider !== 'apns') continue;
      if (isForegroundDevice(r.presence, t.device_id)) continue;
      jobs.push({ userId: r.user_id, token: t });
    }
  }

  const payload = buildApnsPayload({
    title: ctx.sender_display_name || 'Someone',
    body: truncate(content, 80),
    sessionId: session_id,
    messageId,
  });

  // Inbox fan-out: every non-muted recipient gets a lightweight ping on their
  // own MQTT topic so connected clients can light up an unread red dot
  // without subscribing to per-session topics. has_unread is recomputed
  // server-side from session_read_markers, so the payload only needs
  // session_id — clients re-query list_current_actor_sessions on receipt.
  const inboxUserIds = mqtt
    ? [...new Set(ctx.recipients.filter((r) => !r.muted).map((r) => r.user_id))]
    : [];
  // `team_id` and an explicit `type` are B7: without the team a receiving
  // client cannot build the session/live topic it may want to subscribe to,
  // and `type` was only ever implied. Both are additive — the field readers on
  // desktop and iOS default a missing `type` to "message".
  const inboxPayload = mqtt
    ? JSON.stringify({
        v: 2,
        type: 'message',
        team_id: msg.team_id ?? null,
        session_id,
        message_id: messageId,
        ts: now().getTime(),
      })
    : null;

  const [apnsResults, inboxResults] = await Promise.all([
    Promise.allSettled(jobs.map((j) => apns.send(j.token.token, payload))),
    mqtt
      ? Promise.allSettled(inboxUserIds.map((uid) => mqtt.publish(`inbox/${uid}`, inboxPayload)))
      : Promise.resolve([]),
  ]);

  let sent = 0, revoked = 0, failed = 0;
  for (let i = 0; i < apnsResults.length; i++) {
    const job = jobs[i];
    const r = apnsResults[i];
    if (r.status === 'fulfilled') {
      if (r.value.status === 200) { sent++; continue; }
      if (r.value.status === 410 || r.value.reason === 'BadDeviceToken' || r.value.reason === 'Unregistered') {
        await sb.revokeToken(job.token.token);
        revoked++;
        continue;
      }
    }
    failed++;
  }

  let inboxSent = 0, inboxFailed = 0;
  for (const r of inboxResults) {
    if (r.status === 'fulfilled') inboxSent++; else inboxFailed++;
  }

  return {
    sent, revoked, failed, recipients: ctx.recipients.length,
    inboxSent, inboxFailed, inboxTargets: inboxUserIds.length,
  };
}

export function buildApnsPayload({ title, body, sessionId, messageId }) {
  return {
    aps: {
      alert: { title, body },
      'thread-id': sessionId,
      sound: 'default',
      badge: 1,
    },
    data: { session_id: sessionId, message_id: messageId, kind: 'message' },
  };
}
