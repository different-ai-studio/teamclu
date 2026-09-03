// Outbox sender — ports iOS `OutboxSender` to the Tauri/web client.
//
// Loop: every TICK_MS, fetch due rows (state=pending && nextAttemptAt <= now)
// from `useOutboxStore`, run `attempt()` on each. On success → state=delivered
// (UI shows check, row is GC'd after the next tick). On failure → bump
// attempt_count, schedule next nextAttemptAt with exponential backoff
// (`outboxBackoffMs`), or transition to `failed` once `OUTBOX_MAX_ATTEMPTS`
// hit (user can click the bubble's error dot to call `useOutboxStore.retry`).
//
// The sender is a singleton — `startOutboxSender()` is idempotent and should
// be called once on app boot after the outbox store is hydrated.

import { create as createMessage, toBinary } from "@bufbuild/protobuf";
import { isAgentActorType } from "@/lib/actor/actor-type";
import { BackendError, getBackend } from "@/lib/backend";
import { ensureAgentRuntimesForSession } from "@/lib/teamclu/ensure-agent-runtime";
import { resolveSessionWorkspaceHintForRuntimeStart } from "@/lib/teamclu/resolve-runtime-start-workspace";
import {
  LiveEventEnvelopeSchema,
  MessageKind,
  MessageSchema,
  SessionMessageEnvelopeSchema,
  type LiveEventEnvelope,
} from "@/lib/proto/teamclu_pb";
import { mqttPublish } from "@/lib/mqtt/mqtt-bridge";
import {
  OUTBOX_MAX_ATTEMPTS,
  outboxBackoffMs,
  useOutboxStore,
  type OutboxEntry,
} from "@/stores/outbox-store";
import { useWorkspaceStore } from "@/stores/workspace";
import {
  sessionFlowError,
  sessionFlowLog,
  summarizeText,
} from "@/lib/session/session-flow-log";
import { bumpSessionListLastMessage } from "@/lib/session/session-list-preview";
import { maybeAutoTitleSessionFromFirstMessage } from "@/lib/session/session-auto-title";
import { useSessionListStore } from "@/stores/session-list-store";
import { runtimeForkFromForSession } from "@/lib/session/thread-fork";

const TICK_MS = 1000;
const DELIVERED_GC_MS = 5000;

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
let inflightTick = false;

function buildOutgoingMetadata(entry: OutboxEntry): Record<string, unknown> {
  const displayMentionActorIds = entry.displayMentionActorIds ?? [];
  return {
    mention_actor_ids: entry.mentionActorIds,
    ...(displayMentionActorIds.length > 0
      ? { display_mention_actor_ids: displayMentionActorIds }
      : {}),
    ...(entry.attachmentUrls.length > 0
      ? { attachment_urls: entry.attachmentUrls }
      : {}),
  };
}

function buildLiveEnvelope(
  entry: OutboxEntry,
  metadata: Record<string, unknown>,
): LiveEventEnvelope {
  const createdAtSec = BigInt(
    Math.floor(new Date(entry.createdAt).getTime() / 1000),
  );
  const proto = createMessage(MessageSchema, {
    messageId: entry.messageId,
    sessionId: entry.sessionId,
    senderActorId: entry.senderActorId,
    kind: MessageKind.TEXT,
    content: entry.content,
    metadataJson: JSON.stringify(metadata),
    createdAt: createdAtSec,
    model: entry.model ?? "",
  });
  const sessionEnv = createMessage(SessionMessageEnvelopeSchema, {
    message: proto,
    mentionActorIds: entry.mentionActorIds,
  });
  return createMessage(LiveEventEnvelopeSchema, {
    eventId: crypto.randomUUID(),
    eventType: "message.created",
    sessionId: entry.sessionId,
    actorId: entry.senderActorId,
    sentAt: createdAtSec,
    body: toBinary(SessionMessageEnvelopeSchema, sessionEnv),
  });
}

async function resolveLocalDaemonActorIdIfTauri(): Promise<string | null> {
  const { isTauri } = await import("@/lib/utils");
  if (!isTauri()) return null;
  try {
    const { getLocalDaemonActorId } = await import("@/lib/daemon/daemon-agent-admin");
    return await getLocalDaemonActorId();
  } catch {
    return null;
  }
}

/** True when every @mention is this machine's local daemon (solo local agent). */
export function isLocalOnlyAgentMention(
  mentionActorIds: string[],
  localDaemonActorId: string | null | undefined,
): boolean {
  const localId = localDaemonActorId?.trim() || "";
  if (!localId || mentionActorIds.length === 0) return false;
  return mentionActorIds.every((id) => id === localId);
}

async function ensureLocalRuntimeForFastPath(
  entry: OutboxEntry,
  localDaemonActorId: string,
): Promise<void> {
  const { runtimeStart } = await import("@/lib/daemon/teamclu-rpc");
  const { AgentType } = await import("@/lib/proto/amux_pb");
  let agentType = AgentType.OPENCODE;
  try {
    const { getDaemonLocalAgent } = await import("@/lib/daemon/daemon-local-client");
    const { resolveAmuxAgentType } = await import("@/lib/agent/amux-agent-type");
    agentType = resolveAmuxAgentType(await getDaemonLocalAgent());
  } catch {
    // Keep OPENCODE — matches daemon default when config is unavailable.
  }
  // Carry a workspace id. This used to send `""`, and the daemon skips its
  // workspace resolver entirely for an empty one — it starts in whatever
  // `worktree` says instead. The slow path that follows ~0.8s later DOES
  // resolve, and when it lands on a different directory the runtime this call
  // just started is superseded and the backend respawns. Measured on a first
  // message: `~/TeamClu` here, `~/TeamClu Dev` there, and a 5.5s cold start
  // paid twice. A path that exists to be fast was costing an extra one.
  //
  // Order matters, and both of the cheap sources it used to have are
  // session-blind: the enqueue hint is per-message, but `cachedDefaultWorkspaceId`
  // is this device's default for the AGENT, shared by every session it runs.
  // Sending the first message in a brand-new app therefore started the runtime
  // in the app that happened to be open before, and the agent read and edited
  // that app's files while the new one deployed as the untouched template.
  // The session's own binding goes in between — local cache only, so the fast
  // path stays local, and null on a cold cache falls through to the old answer.
  const [{ cachedDefaultWorkspaceId }, { cachedSessionWorkspaceForLocalDaemon }] =
    await Promise.all([
      import("@/stores/agent-default-workspace-store"),
      import("@/lib/teamclu/resolve-runtime-start-workspace"),
    ]);
  const bound = await cachedSessionWorkspaceForLocalDaemon({
    teamId: entry.teamId,
    sessionId: entry.sessionId,
    localDaemonActorId,
  });
  const workspaceId =
    entry.workspaceIdHint?.trim() ||
    bound?.workspaceId ||
    cachedDefaultWorkspaceId([localDaemonActorId]);
  // Same reasoning for the worktree: the workspace store is whichever folder
  // the desktop has open, which is not necessarily the one this session runs
  // in. It is only the daemon's fallback for an id it cannot resolve, but when
  // that fallback fires it decides the directory outright.
  const worktree =
    bound?.workspacePath || (useWorkspaceStore.getState().workspacePath?.trim() ?? "");

  const forkFrom = runtimeForkFromForSession(entry.sessionId);
  sessionFlowLog("outbox_sender.local_runtime_start.begin", {
    messageId: entry.messageId,
    sessionId: entry.sessionId,
    teamId: entry.teamId,
    localDaemonActorId,
    worktree: worktree || null,
    workspaceId: workspaceId || null,
    forkFrom: forkFrom ?? null,
  });
  await runtimeStart({
    targetActorId: localDaemonActorId,
    workspaceId,
    worktree,
    sessionId: entry.sessionId,
    agentType,
    modelId: entry.model ?? "",
    ...(forkFrom ? { forkFrom } : {}),
  });
  sessionFlowLog("outbox_sender.local_runtime_start.ok", {
    messageId: entry.messageId,
    sessionId: entry.sessionId,
    teamId: entry.teamId,
  });
}

async function insertOutgoingCloud(
  entry: OutboxEntry,
  metadata: Record<string, unknown>,
): Promise<{ duplicateAlreadyInserted: boolean }> {
  sessionFlowLog("outbox_sender.message_insert.begin", {
    messageId: entry.messageId,
    sessionId: entry.sessionId,
    teamId: entry.teamId,
  });
  let duplicateAlreadyInserted = false;
  try {
    await getBackend().messages.insertOutgoingMessage({
      id: entry.messageId,
      teamId: entry.teamId,
      sessionId: entry.sessionId,
      senderActorId: entry.senderActorId,
      kind: "text",
      content: entry.content,
      model: entry.model ?? null,
      metadata,
      createdAt: entry.createdAt,
    });
  } catch (error) {
    // Conflict on `id` means this same message already landed on a prior
    // attempt (the network round-trip dropped before we got the ACK).
    if (error instanceof BackendError && error.category === "Conflict") {
      duplicateAlreadyInserted = true;
    } else {
      throw error;
    }
  }
  sessionFlowLog("outbox_sender.message_insert.ok", {
    messageId: entry.messageId,
    sessionId: entry.sessionId,
    teamId: entry.teamId,
    duplicateAlreadyInserted,
  });
  return { duplicateAlreadyInserted };
}

function afterCloudPersist(entry: OutboxEntry): void {
  bumpSessionListLastMessage(entry.sessionId, entry.content, {
    at: entry.createdAt,
    markUnread: false,
  });
  void useSessionListStore
    .getState()
    .markSessionViewed(entry.sessionId, entry.messageId);
  // Quick-empty / solo-agent shells start as "Name (HH:mm)". Once the first
  // user message is persisted, rename from its summary so the session list
  // is distinguishable. No-op once the title is no longer a placeholder.
  void maybeAutoTitleSessionFromFirstMessage(entry.sessionId, entry.content).catch(
    (err) => {
      console.warn("[outbox] auto-title failed (non-fatal):", err);
    },
  );
  useOutboxStore.getState().markCloudPersisted(entry.messageId);
}

async function publishSessionLive(
  entry: OutboxEntry,
  liveBytes: Uint8Array,
): Promise<void> {
  const topic = `amux/${entry.teamId}/session/${entry.sessionId}/live`;
  sessionFlowLog("outbox_sender.mqtt_publish.begin", {
    messageId: entry.messageId,
    sessionId: entry.sessionId,
    teamId: entry.teamId,
    topic,
    mentionActorIds: entry.mentionActorIds,
    ...summarizeText(entry.content),
  });
  try {
    await mqttPublish(topic, liveBytes, false);
    sessionFlowLog("outbox_sender.mqtt_publish.done", {
      messageId: entry.messageId,
      sessionId: entry.sessionId,
      teamId: entry.teamId,
    });
  } catch (err) {
    sessionFlowError("outbox_sender.mqtt_publish.failed", err, {
      messageId: entry.messageId,
      sessionId: entry.sessionId,
      teamId: entry.teamId,
    });
    if (entry.mentionActorIds.length > 0) {
      console.warn("[outbox] agent-mentioned MQTT publish failed; will retry", {
        messageId: entry.messageId,
        sessionId: entry.sessionId,
        topic,
        error: err,
      });
      throw err;
    }
    // Unmentioned messages are passive session history; Supabase is enough
    // for other clients to hydrate them later.
    console.warn("[outbox] MQTT publish failed (best-effort):", err);
  }
}

function kickRemoteRuntimeEnsure(
  entry: OutboxEntry,
  localDaemonActorId: string | null,
): void {
  if (entry.mentionActorIds.length === 0) return;
  void (async () => {
    const participants = await getBackend().sessionMembers.listParticipants(
      entry.sessionId,
    );
    const agentActorIds = entry.mentionActorIds.filter((id) => {
      const row = participants.find((p) => p.id === id);
      return row ? isAgentActorType(row.actor_type) : false;
    });
    if (agentActorIds.length === 0) return;
    const workspaceIdHint =
      entry.workspaceIdHint?.trim() ||
      (await resolveSessionWorkspaceHintForRuntimeStart({
        teamId: entry.teamId,
        localWorkspacePath: useWorkspaceStore.getState().workspacePath,
        sessionId: entry.sessionId,
        agentActorIds,
        localDaemonActorId,
      }));
    sessionFlowLog("outbox_sender.runtime_ensure.begin", {
      messageId: entry.messageId,
      sessionId: entry.sessionId,
      teamId: entry.teamId,
      agentActorIds,
      workspaceIdHint: workspaceIdHint || null,
    });
    await ensureAgentRuntimesForSession({
      sessionId: entry.sessionId,
      teamId: entry.teamId,
      agentActorIds,
      modelId: entry.model ?? undefined,
      workspaceIdHint: workspaceIdHint || undefined,
      reason: "outbox_send",
    });
  })().catch((err) => {
    sessionFlowError("outbox_sender.runtime_ensure.failed", err, {
      messageId: entry.messageId,
      sessionId: entry.sessionId,
      teamId: entry.teamId,
    });
  });
}

/**
 * Local-only agent path: loopback runtimeStart → local live ingest → MQTT →
 * Cloud insert (best-effort). Cloud failure does not fail delivery.
 */
async function attemptLocalFastPath(
  entry: OutboxEntry,
  metadata: Record<string, unknown>,
  liveBytes: Uint8Array,
  localDaemonActorId: string,
): Promise<void> {
  const store = useOutboxStore.getState();
  sessionFlowLog("outbox_sender.local_fast_path.begin", {
    messageId: entry.messageId,
    sessionId: entry.sessionId,
    teamId: entry.teamId,
    localDaemonActorId,
  });

  await ensureLocalRuntimeForFastPath(entry, localDaemonActorId);

  const { ingestSessionLiveLocally } = await import("@/lib/daemon/daemon-local-client");
  sessionFlowLog("outbox_sender.local_ingest.begin", {
    messageId: entry.messageId,
    sessionId: entry.sessionId,
  });
  await ingestSessionLiveLocally(entry.sessionId, liveBytes);
  sessionFlowLog("outbox_sender.local_ingest.ok", {
    messageId: entry.messageId,
    sessionId: entry.sessionId,
  });

  // Fan-out to OTHER members and history sync are both best-effort from here:
  // the agent this message was addressed to already has it (local ingest
  // above), so failing the send on a broker or Cloud problem would report a
  // delivery that did happen as one that did not — and leave the user staring
  // at a failed bubble while the agent replies to it.
  //
  // Re-delivery when the broker returns is safe: the live event carries the
  // same `message_id`, which every consumer dedups on.
  try {
    await publishSessionLive(entry, liveBytes);
  } catch (err) {
    sessionFlowError("outbox_sender.mqtt_publish.best_effort_failed", err, {
      messageId: entry.messageId,
      sessionId: entry.sessionId,
      teamId: entry.teamId,
    });
    console.warn("[outbox] MQTT fan-out failed after local deliver (best-effort):", err);
  }

  try {
    await insertOutgoingCloud(entry, metadata);
    afterCloudPersist(entry);
  } catch (err) {
    // Local agent already has the message; Cloud is history sync only.
    sessionFlowError("outbox_sender.message_insert.best_effort_failed", err, {
      messageId: entry.messageId,
      sessionId: entry.sessionId,
      teamId: entry.teamId,
    });
    console.warn("[outbox] Cloud insert failed after local deliver (best-effort):", err);
    bumpSessionListLastMessage(entry.sessionId, entry.content, {
      at: entry.createdAt,
      markUnread: false,
    });
  }

  await store.updateState(entry.messageId, {
    state: "delivered",
    lastError: null,
  });
  sessionFlowLog("outbox_sender.attempt.delivered", {
    messageId: entry.messageId,
    sessionId: entry.sessionId,
    teamId: entry.teamId,
    path: "local_fast",
  });
}

/** Remote / multi-agent path: Cloud → MQTT → best-effort runtime ensure. */
async function attemptRemotePath(
  entry: OutboxEntry,
  metadata: Record<string, unknown>,
  liveBytes: Uint8Array,
  localDaemonActorId: string | null,
): Promise<void> {
  const store = useOutboxStore.getState();

  // Persist first so daemon catchup (triggered by runtimeStart below) can
  // see @-mentioned rows. Previously runtimeStart ran before insert, so
  // dedup catchup always replayed an empty slice for the outbound message.
  await insertOutgoingCloud(entry, metadata);
  afterCloudPersist(entry);

  // Fan out to OTHER members FIRST. Publishing the live event both delivers
  // the message to everyone in real time AND is what wakes an online daemon
  // (the daemon subscribes to this topic). This MUST happen before — and
  // independently of — ensuring the mentioned agent's runtime below.
  await publishSessionLive(entry, liveBytes);

  // Belt-and-suspenders cold-start: ensure the mentioned agent's runtime is up.
  // Best-effort and NON-BLOCKING on purpose.
  kickRemoteRuntimeEnsure(entry, localDaemonActorId);

  await store.updateState(entry.messageId, {
    state: "delivered",
    lastError: null,
  });
  sessionFlowLog("outbox_sender.attempt.delivered", {
    messageId: entry.messageId,
    sessionId: entry.sessionId,
    teamId: entry.teamId,
    path: "remote",
  });
}

async function attempt(entry: OutboxEntry): Promise<void> {
  const store = useOutboxStore.getState();
  const now = new Date().toISOString();
  sessionFlowLog("outbox_sender.attempt.begin", {
    messageId: entry.messageId,
    sessionId: entry.sessionId,
    teamId: entry.teamId,
    senderActorId: entry.senderActorId,
    model: entry.model ?? null,
    attemptCount: entry.attemptCount,
    mentionActorCount: entry.mentionActorIds.length,
    attachmentUrlCount: entry.attachmentUrls.length,
    ...summarizeText(entry.content),
  });

  await store.updateState(entry.messageId, {
    state: "inFlight",
    lastAttemptAt: now,
  });

  try {
    const metadata = buildOutgoingMetadata(entry);
    const live = buildLiveEnvelope(entry, metadata);
    const liveBytes = toBinary(LiveEventEnvelopeSchema, live);
    const localDaemonActorId = await resolveLocalDaemonActorIdIfTauri();

    if (isLocalOnlyAgentMention(entry.mentionActorIds, localDaemonActorId)) {
      await attemptLocalFastPath(
        entry,
        metadata,
        liveBytes,
        localDaemonActorId!,
      );
      return;
    }

    await attemptRemotePath(entry, metadata, liveBytes, localDaemonActorId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const nextAttempt = entry.attemptCount + 1;
    sessionFlowError("outbox_sender.attempt.failed", e, {
      messageId: entry.messageId,
      sessionId: entry.sessionId,
      teamId: entry.teamId,
      nextAttempt,
      willRetry: nextAttempt < OUTBOX_MAX_ATTEMPTS,
    });
    if (nextAttempt >= OUTBOX_MAX_ATTEMPTS) {
      await store.updateState(entry.messageId, {
        state: "failed",
        attemptCount: nextAttempt,
        lastError: msg,
        nextAttemptAt: null,
      });
    } else {
      const next = new Date(Date.now() + outboxBackoffMs(nextAttempt));
      await store.updateState(entry.messageId, {
        state: "pending",
        attemptCount: nextAttempt,
        lastError: msg,
        nextAttemptAt: next.toISOString(),
      });
    }
  }
}

async function tick(): Promise<void> {
  if (inflightTick) return;
  inflightTick = true;
  try {
    const nowMs = Date.now();
    const due: OutboxEntry[] = [];
    const deliveredToGc: string[] = [];

    for (const entry of Object.values(useOutboxStore.getState().byId)) {
      if (entry.state === "pending") {
        const due_at = entry.nextAttemptAt
          ? new Date(entry.nextAttemptAt).getTime()
          : 0;
        if (due_at <= nowMs) due.push(entry);
      } else if (entry.state === "delivered") {
        const since = nowMs - new Date(entry.updatedAt).getTime();
        if (since >= DELIVERED_GC_MS) deliveredToGc.push(entry.messageId);
      }
    }
    if (due.length > 0 || deliveredToGc.length > 0) {
      sessionFlowLog("outbox_sender.tick", {
        dueCount: due.length,
        deliveredToGcCount: deliveredToGc.length,
        dueMessageIds: due.map((entry) => entry.messageId),
      });
    }

    for (const id of deliveredToGc) {
      await useOutboxStore.getState().remove(id);
    }

    // Run sequentially — keeps Supabase load bounded and avoids interleaved
    // state transitions for the same row across overlapping attempts.
    for (const e of due) await attempt(e);
  } finally {
    inflightTick = false;
  }
}

/** Start the outbox sender loop. Idempotent — safe to call multiple times. */
export function startOutboxSender(): void {
  if (started) return;
  started = true;
  sessionFlowLog("outbox_sender.start");
  // Fire one tick immediately so a freshly-enqueued message goes out without
  // waiting up to TICK_MS — feels responsive.
  void tick();
  timer = setInterval(() => void tick(), TICK_MS);
}

/**
 * Flush due rows now. Call after `enqueue` so a new message does not sit until
 * the next `TICK_MS` interval (up to 1s of dead air after the bubble appears).
 * No-op until `startOutboxSender` has run; the start path already ticks once.
 */
export function kickOutboxSender(): void {
  if (!started) return;
  void tick();
}

/** Stop the loop. Useful in tests; not normally called in production. */
export function stopOutboxSender(): void {
  if (!started) return;
  started = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
