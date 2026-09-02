import { invoke } from "@tauri-apps/api/core";
import { isChromeExtension } from "@/lib/platform";
import { isTauri } from "@/lib/utils";
import { localAgent as buildDefaultLocalAgent } from "@/lib/build-config";
import { reportLocalCacheEmptyTeamId } from "@/lib/telemetry/local-cache-error-report";

/**
 * Team-scoped loaders must never be called with a blank team id.
 *
 * Doing so used to reach the Rust gate and come back as a *gate mismatch*
 * ("requested=" with nothing after it), which reads like the team state
 * diverged when in fact the caller simply had no team yet. Catch it here,
 * return empty, and report with a stack so the caller can be found.
 */
function hasTeamId(command: string, teamId: string | null | undefined): teamId is string {
  if (teamId && teamId.trim()) return true;
  reportLocalCacheEmptyTeamId(command);
  return false;
}

// ── runtime hint for opencode enrichment ───────────────────────────────────

/**
 * The Rust side only opens opencode's private database to enrich tool-call
 * parts when the message runtime is opencode (PERF-2). It cannot learn the
 * runtime itself without reading daemon state, so we pass the daemon's current
 * local agent along. Cached briefly: switching runtimes restarts the daemon,
 * so a 30 s window is plenty. Falls back to the build default when the daemon
 * is unreachable, which is what the daemon itself would report.
 */
const RUNTIME_HINT_TTL_MS = 30_000;
let runtimeHint: { value: string; at: number } | null = null;

async function currentLocalRuntime(): Promise<string> {
  const now = Date.now();
  if (runtimeHint && now - runtimeHint.at < RUNTIME_HINT_TTL_MS) return runtimeHint.value;
  let value: string = buildDefaultLocalAgent;
  try {
    const { getDaemonLocalAgent } = await import("@/lib/daemon-local-client");
    value = await getDaemonLocalAgent();
  } catch {
    // daemon not reachable yet: keep the build default
  }
  runtimeHint = { value, at: now };
  return value;
}

/** Test-only: forget the cached runtime hint. */
export function resetLocalRuntimeHintForTests(): void {
  runtimeHint = null;
}

// ── team gate ──────────────────────────────────────────────────────────────

/**
 * Point the local-cache team gate at `teamId`. Every upsert batch is rejected
 * by the Rust gate when a row's team differs from the current gate team, so any
 * caller that populates rows for a team out-of-band (E2E seeding, team switch)
 * must set the gate first. Pass `null` to clear it. No-op outside Tauri.
 */
export async function setLocalCacheCurrentTeam(
  teamId: string | null,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("local_cache_set_current_team", { teamId });
}

// ── Row types (mirror Rust serde shape, camelCase) ─────────────────────────

export type ActorRow = {
  id: string;
  teamId: string;
  actorType: string;
  displayName: string;
  avatarUrl?: string | null;
  memberStatus?: string | null;
  agentStatus?: string | null;
  lastActiveAt?: string | null;
  metadataJson?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  syncedAt: string;
  // Display hints (member role / agent Team|Personal visibility) cached so the
  // list's first offline paint matches the network paint — no subtitle pop-in.
  teamRole?: string | null;
  agentVisibility?: string | null;
  ownerMemberId?: string | null;
};

export type SessionRow = {
  id: string;
  teamId: string;
  title?: string | null;
  mode?: string | null;
  primaryAgentId?: string | null;
  ideaId?: string | null;
  summary?: string | null;
  lastMessagePreview?: string | null;
  lastMessageAt?: string | null;
  createdBy?: string | null;
  metadataJson?: string | null;
  source?: string | null;
  cronJobId?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  syncedAt: string;
};

export type SessionWorkspaceRow = {
  sessionId: string;
  teamId: string;
  viewerMemberId: string;
  agentId: string;
  workspaceId?: string | null;
  workspacePath?: string | null;
  updatedAt: string;
};

export type SessionParticipantRow = {
  id: string;
  sessionId: string;
  actorId: string;
  joinedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  syncedAt: string;
};

export type MessageRow = {
  id: string;
  teamId: string;
  sessionId: string;
  turnId?: string | null;
  senderActorId?: string | null;
  replyToMessageId?: string | null;
  kind: string;
  content: string;
  metadataJson?: string | null;
  model?: string | null;
  mentionsJson?: string | null;
  /** 'supabase' | 'mqtt-live' | 'local-only' */
  origin: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  syncedAt: string;
  /** Serialized MessagePart[] (thinking / tool_call / text). Populated when
   * the streaming pipeline merges runtime events into the persisted message
   * so that reloading the session restores the full conversation. */
  partsJson?: string | null;
};

/** Mirror of Rust `OutboxRow`. One pending/in-flight send through Supabase +
 * MQTT with exponential backoff. `messageId` matches the optimistic UI bubble
 * id so live echo can flip status → delivered. */
export type OutboxRow = {
  messageId: string;
  teamId: string;
  sessionId: string;
  senderActorId: string;
  content: string;
  model?: string | null;
  mentionActorIdsJson?: string | null;
  displayMentionActorIdsJson?: string | null;
  attachmentUrlsJson?: string | null;
  /** 'pending' | 'inFlight' | 'delivered' | 'failed' */
  state: string;
  attemptCount: number;
  lastAttemptAt?: string | null;
  nextAttemptAt?: string | null;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type IdeaRow = {
  id: string;
  teamId: string;
  workspaceId?: string | null;
  parentId?: string | null;
  title: string;
  description?: string | null;
  status?: string | null;
  createdBy?: string | null;
  sortOrder?: number | null;
  archived: number;
  metadataJson?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  syncedAt: string;
};

export type ClaimRow = {
  id: string;
  ideaId: string;
  actorId: string;
  claimedAt: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  syncedAt: string;
};

export type SubmissionRow = {
  id: string;
  ideaId: string;
  actorId: string;
  content?: string | null;
  submittedAt: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  syncedAt: string;
};

export type AgentRuntimeEventRow = {
  id: string;
  sessionId: string;
  turnId?: string | null;
  senderActorId?: string | null;
  /** 'agent_tool_call' | 'agent_tool_result' | 'agent_thinking' */
  kind: string;
  content: string;
  metadataJson?: string | null;
  model?: string | null;
  createdAt: string;
};

// ── actor ──────────────────────────────────────────────────────────────────

export async function upsertActorsBatch(rows: ActorRow[]): Promise<void> {
  if (!isTauri() || rows.length === 0) return;
  await invoke("local_cache_actor_upsert_batch", { rows });
}

export async function loadActorsForTeam(
  teamId: string,
  includeDeleted = false,
): Promise<ActorRow[]> {
  if (!isTauri()) return [];
  if (!hasTeamId("actor_load_team", teamId)) return [];
  return invoke("local_cache_actor_load_team", { teamId, includeDeleted });
}

export async function loadActorsByIds(ids: string[]): Promise<ActorRow[]> {
  if (!isTauri() || ids.length === 0) return [];
  return invoke("local_cache_actor_load_by_ids", { ids });
}

export async function softDeleteActor(
  id: string,
  deletedAt: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("local_cache_actor_soft_delete", { id, deletedAt });
}

// ── session ────────────────────────────────────────────────────────────────

export async function upsertSessionsBatch(rows: SessionRow[]): Promise<void> {
  if (!isTauri() || rows.length === 0) return;
  await invoke("local_cache_session_upsert_batch", { rows });
}

export async function loadSessionsForTeam(
  teamId: string,
  includeDeleted = false,
): Promise<SessionRow[]> {
  if (!isTauri()) return [];
  if (!hasTeamId("session_load_team", teamId)) return [];
  return invoke("local_cache_session_load_team", { teamId, includeDeleted });
}

export async function softDeleteSession(
  id: string,
  deletedAt: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("local_cache_session_soft_delete", { id, deletedAt });
}

export async function upsertSessionWorkspacesBatch(
  rows: SessionWorkspaceRow[],
): Promise<void> {
  if (!isTauri()) return;
  await invoke("local_cache_session_workspace_upsert_batch", { rows });
}

export async function loadSessionWorkspacesForTeam(
  teamId: string,
  viewerMemberId: string,
): Promise<SessionWorkspaceRow[]> {
  if (!isTauri() || !viewerMemberId.trim()) return [];
  if (!hasTeamId("session_workspace_load_team", teamId)) return [];
  return invoke("local_cache_session_workspace_load_team", {
    teamId,
    viewerMemberId,
  });
}

// ── session_participant ────────────────────────────────────────────────────

export async function upsertSessionParticipantsBatch(
  rows: SessionParticipantRow[],
): Promise<void> {
  if (!isTauri() || rows.length === 0) return;
  await invoke("local_cache_session_participant_upsert_batch", { rows });
}

export async function loadSessionParticipants(
  sessionId: string,
  includeDeleted = false,
): Promise<SessionParticipantRow[]> {
  if (!isTauri()) return [];
  return invoke("local_cache_session_participant_load_session", {
    sessionId,
    includeDeleted,
  });
}

/**
 * Return active cached session ids for one actor in a team. This keeps the
 * cold-start cache scoped to the signed-in actor rather than exposing every
 * cached team session while the network list is unavailable.
 */
export async function loadSessionIdsForActor(
  teamId: string,
  actorId: string,
): Promise<string[]> {
  if (!isTauri() || !hasTeamId("session_participant_load_actor", teamId) || !actorId.trim()) return [];
  return invoke("local_cache_session_participant_load_actor", { actorId, teamId });
}

export async function softDeleteSessionParticipant(
  id: string,
  deletedAt: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("local_cache_session_participant_soft_delete", { id, deletedAt });
}

// ── message ────────────────────────────────────────────────────────────────

export async function upsertMessagesBatch(rows: MessageRow[]): Promise<void> {
  if (rows.length === 0) return;
  if (isTauri()) {
    await invoke("local_cache_message_upsert_batch", { rows });
    return;
  }
  if (isChromeExtension()) {
    const { upsertExtensionMessagesBatch } = await import(
      "@/lib/extension-message-cache"
    );
    await upsertExtensionMessagesBatch(rows);
  }
}

export async function loadMessagesForSession(
  sessionId: string,
  includeDeleted = false,
  workspacePath?: string | null,
): Promise<MessageRow[]> {
  if (isTauri()) {
    return invoke("local_cache_message_load_session", {
      sessionId,
      includeDeleted,
      workspacePath: workspacePath ?? null,
      runtime: await currentLocalRuntime(),
    });
  }
  if (isChromeExtension()) {
    const { loadExtensionMessagesForSession } = await import(
      "@/lib/extension-message-cache"
    );
    return loadExtensionMessagesForSession(sessionId, includeDeleted);
  }
  return [];
}

export async function softDeleteMessage(
  id: string,
  deletedAt: string,
): Promise<void> {
  if (isTauri()) {
    await invoke("local_cache_message_soft_delete", { id, deletedAt });
    return;
  }
  if (isChromeExtension()) {
    const { softDeleteExtensionMessage } = await import(
      "@/lib/extension-message-cache"
    );
    await softDeleteExtensionMessage(id, deletedAt);
  }
}

/** Merge parts_json into an existing message row without bumping updated_at.
 * Used when the streaming pipeline finalizes — we attach thinking/tool_call
 * parts to the AGENT_REPLY that already landed via Supabase/MQTT. */
export async function setMessageParts(
  messageId: string,
  partsJson: string,
  workspacePath?: string | null,
): Promise<string> {
  if (isTauri()) {
    return invoke<string>("local_cache_message_set_parts", {
      messageId,
      partsJson,
      workspacePath: workspacePath ?? null,
      runtime: await currentLocalRuntime(),
    });
  }
  if (isChromeExtension()) {
    const { setExtensionMessageParts } = await import(
      "@/lib/extension-message-cache"
    );
    return setExtensionMessageParts(messageId, partsJson);
  }
  return partsJson;
}

export async function enrichMessageParts(
  partsJson: string,
  workspacePath?: string | null,
): Promise<string> {
  if (!isTauri()) return partsJson;
  return invoke<string>("local_cache_message_enrich_parts", {
    partsJson,
    workspacePath: workspacePath ?? null,
    runtime: await currentLocalRuntime(),
  });
}

// ── outbox ─────────────────────────────────────────────────────────────────

export async function upsertOutbox(row: OutboxRow): Promise<void> {
  if (!isTauri()) return;
  await invoke("local_cache_outbox_upsert", { row });
}

export async function deleteOutbox(messageId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("local_cache_outbox_delete", { messageId });
}

export async function listAllOutbox(): Promise<OutboxRow[]> {
  if (!isTauri()) return [];
  return invoke<OutboxRow[]>("local_cache_outbox_list_all");
}

// ── idea ───────────────────────────────────────────────────────────────────

export async function upsertIdeasBatch(rows: IdeaRow[]): Promise<void> {
  if (!isTauri() || rows.length === 0) return;
  await invoke("local_cache_idea_upsert_batch", { rows });
}

export async function loadIdeasForTeam(
  teamId: string,
  includeDeleted = false,
): Promise<IdeaRow[]> {
  if (!isTauri()) return [];
  if (!hasTeamId("idea_load_team", teamId)) return [];
  return invoke("local_cache_idea_load_team", { teamId, includeDeleted });
}

export async function softDeleteIdea(
  id: string,
  deletedAt: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("local_cache_idea_soft_delete", { id, deletedAt });
}

// ── claim ──────────────────────────────────────────────────────────────────

export async function upsertClaimsBatch(rows: ClaimRow[]): Promise<void> {
  if (!isTauri() || rows.length === 0) return;
  await invoke("local_cache_claim_upsert_batch", { rows });
}

export async function loadClaimsForIdea(
  ideaId: string,
  includeDeleted = false,
): Promise<ClaimRow[]> {
  if (!isTauri()) return [];
  return invoke("local_cache_claim_load_idea", { ideaId, includeDeleted });
}

export async function softDeleteClaim(
  id: string,
  deletedAt: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("local_cache_claim_soft_delete", { id, deletedAt });
}

// ── submission ─────────────────────────────────────────────────────────────

export async function upsertSubmissionsBatch(
  rows: SubmissionRow[],
): Promise<void> {
  if (!isTauri() || rows.length === 0) return;
  await invoke("local_cache_submission_upsert_batch", { rows });
}

export async function loadSubmissionsForIdea(
  ideaId: string,
  includeDeleted = false,
): Promise<SubmissionRow[]> {
  if (!isTauri()) return [];
  return invoke("local_cache_submission_load_idea", { ideaId, includeDeleted });
}

export async function softDeleteSubmission(
  id: string,
  deletedAt: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("local_cache_submission_soft_delete", { id, deletedAt });
}

// ── sync watermark ─────────────────────────────────────────────────────────

export async function getWatermark(
  tableName: string,
  teamId: string,
): Promise<string | null> {
  if (!isTauri()) return null;
  const res = await invoke<string | null>("local_cache_watermark_get", {
    tableName,
    teamId,
  });
  return res ?? null;
}

export async function setWatermark(
  tableName: string,
  teamId: string,
  lastSyncAt: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("local_cache_watermark_set", { tableName, teamId, lastSyncAt });
}

// ── clear_team ─────────────────────────────────────────────────────────────

export async function clearTeam(teamId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("local_cache_clear_team", { teamId });
}

// ── Backwards-compat re-exports for agent runtime event cache callers ───────
// The narrow API is preserved; long-term these callers will migrate
// to the generic upsert/load pattern.

export async function insertAgentRuntimeEvent(
  row: AgentRuntimeEventRow,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("local_cache_agent_runtime_event_insert", { record: row });
}

export async function loadAgentRuntimeEvents(
  sessionId: string,
): Promise<AgentRuntimeEventRow[]> {
  if (!isTauri()) return [];
  return invoke<AgentRuntimeEventRow[]>(
    "local_cache_agent_runtime_event_load",
    { sessionId },
  );
}

export async function pruneAgentRuntimeEvents(maxRows = 5000): Promise<void> {
  if (!isTauri()) return;
  await invoke("local_cache_agent_runtime_event_prune", { maxRows });
}
