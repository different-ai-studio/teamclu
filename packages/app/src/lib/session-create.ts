import { create as createProtoMessage, toBinary } from '@bufbuild/protobuf'
import { runtimeHintsForAgents } from '@/lib/runtime-state-resolve'
import { getBackend } from '@/lib/backend'
import { runtimeStart, setModel } from '@/lib/teamclu-rpc'
import { resolveAmuxAgentType } from '@/lib/amux-agent-type'
import { seedRuntimeStateAfterStart } from '@/lib/seed-runtime-state'
import { runtimeForkFromForSession } from '@/lib/thread-fork'
import { seedLocalDaemonModelsInBackground } from '@/lib/local-daemon-model-catalog'
import {
  normalizeAgentModelId,
} from '@/lib/runtime-state-resolve'
import { resolveAgentSessionModel } from '@/lib/resolve-agent-session-model'
import { useAgentModelPickStore } from '@/stores/agent-model-pick-store'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'
import { useWorkspaceStore } from '@/stores/workspace'
import { useAuthStore } from '@/stores/auth-store'
import { resolveCurrentMemberActorId } from '@/lib/current-actor'
import { trackEvent } from '@/lib/analytics'
import { mqttPublish } from '@/lib/mqtt-bridge'
import {
  LiveEventEnvelopeSchema,
  MessageKind,
  MessageSchema,
  SessionMessageEnvelopeSchema,
} from '@/lib/proto/teamclu_pb'
import {
  upsertSessionsBatch,
  upsertSessionParticipantsBatch,
  type SessionRow,
  type SessionParticipantRow,
} from '@/lib/local-cache'
import { isTauri } from '@/lib/utils'
import {
  sessionFlowError,
  sessionFlowLog,
  summarizeText,
} from '@/lib/session-flow-log'
import {
  ensureCloudWorkspaceIdForAgentRuntime,
  loadAgentWorkspaceLookups,
  resolveAgentRuntimeWorkspaceId,
  resolveCloudWorkspaceIdForLocalPath,
  runtimeStartWorkspaceArgs,
} from '@/lib/teamclu/resolve-runtime-start-workspace'
import { resolveSessionWorkspacePath } from '@/lib/session-by-workspace'
import { RUNTIME_START_RPC_TIMEOUT_MS } from '@/lib/teamclu/runtime-rpc-timeouts'
interface CreateSessionShellArgs {
  teamId: string
  creatorActorId: string
  title: string
  /** Actor IDs to add as participants alongside the creator. */
  additionalActorIds: string[]
  /** When set, the new session row is tagged with this idea_id at insert time. */
  ideaId?: string | null
  /** When set, the new session row is linked to this app_id at insert time. */
  appId?: string
}

interface CreateSessionShellResult {
  sessionId: string
}

/**
 * Inserts the backend rows needed to materialise a new session and its
 * initial participants. Does NOT trigger any agent runtimeStart RPC —
 * callers fire-and-forget {@link startAgentRuntimesAsync} afterward so
 * the UI can switch into the new session immediately while runtimes
 * spawn in the background.
 */
export async function createSessionShell(
  args: CreateSessionShellArgs,
): Promise<CreateSessionShellResult> {
  const requestedSessionId: string = crypto.randomUUID()
  const trimmedTitle = (args.title.split('\n')[0] || args.title).trim().slice(0, 80) || 'New chat'
  sessionFlowLog('session_shell.begin', {
    requestedSessionId,
    teamId: args.teamId,
    creatorActorId: args.creatorActorId,
    additionalActorCount: args.additionalActorIds.length,
    hasIdeaId: !!args.ideaId,
    title: trimmedTitle,
  })

  const participantActorIds = Array.from(new Set([args.creatorActorId, ...args.additionalActorIds]))
  let sessionId = requestedSessionId
  try {
    const created = await getBackend().sessions.createSessionShell({
      id: requestedSessionId,
      teamId: args.teamId,
      createdByActorId: args.creatorActorId,
      title: trimmedTitle,
      additionalActorIds: args.additionalActorIds,
      ideaId: args.ideaId ?? null,
      ...(args.appId ? { appId: args.appId } : {}),
    })
    sessionId = created.sessionId
  } catch (error) {
    sessionFlowError('session_shell.create_backend.failed', error, {
      requestedSessionId,
      teamId: args.teamId,
      participantCount: participantActorIds.length,
    })
    throw error
  }
  sessionFlowLog('session_shell.create_backend.ok', {
    sessionId,
    requestedSessionId,
    teamId: args.teamId,
    participantCount: participantActorIds.length,
  })
  void trackEvent('session_created', {
    participantCount: participantActorIds.length,
    hasIdea: !!args.ideaId,
  })

  // Mirror into local libsql immediately so the session-list-store + Actors
  // panel see the new session without waiting for a Supabase refetch.
  if (isTauri()) {
    const now = new Date().toISOString()
    const sessionRow: SessionRow = {
      id: sessionId,
      teamId: args.teamId,
      title: trimmedTitle,
      mode: 'collab',
      primaryAgentId: null,
      ideaId: args.ideaId ?? null,
      summary: null,
      lastMessagePreview: null,
      lastMessageAt: null,
      createdBy: args.creatorActorId,
      metadataJson: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      syncedAt: now,
    }
    const partRows: SessionParticipantRow[] = participantActorIds.map(actorId => ({
      id: `${sessionId}:${actorId}`,
      sessionId,
      actorId,
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      syncedAt: now,
    }))
    try {
      sessionFlowLog('session_shell.local_cache.begin', {
        sessionId,
        teamId: args.teamId,
        participantCount: partRows.length,
      })
      await upsertSessionsBatch([sessionRow])
      if (partRows.length > 0) await upsertSessionParticipantsBatch(partRows)
      sessionFlowLog('session_shell.local_cache.ok', {
        sessionId,
        teamId: args.teamId,
        participantCount: partRows.length,
      })
    } catch (e) {
      sessionFlowError('session_shell.local_cache.failed', e, {
        sessionId,
        teamId: args.teamId,
      })
      console.warn('[session-create] local cache upsert failed (non-fatal):', e)
    }
  }

  sessionFlowLog('session_shell.ok', {
    sessionId,
    teamId: args.teamId,
  })
  return { sessionId }
}

interface CreateSessionWithFirstMessageArgs {
  teamId: string
  creatorActorId: string
  /** Additional participant actor IDs (members + agents). Creator is added automatically. */
  additionalActorIds: string[]
  /** Subset of `additionalActorIds` that are agents — used to fan out runtime spawns. */
  agentActorIds: string[]
  /** Opening message text. Sent verbatim — no @-mention prefix. */
  messageText: string
  /** Model chosen before creating the session; passed to each started agent runtime. */
  modelId?: string
  /** Backend chosen before creating the session; overrides agent defaults/history. */
  agentType?: number
  ideaId?: string | null
  /** Links the new session to an app (the Apps module opening flow). */
  appId?: string
  /** Overrides the title, which otherwise comes from the message's first line. */
  title?: string
  /**
   * Actors the opening message @-mentions. Normally empty — see the note on
   * the function. An app's opening message DOES mention the local daemon,
   * because an unmentioned message is only silent-queued and the agent would
   * sit there until the user typed something.
   */
  mentionActorIds?: string[]
}

interface CreateSessionWithFirstMessageResult {
  sessionId: string
}

/**
 * One-shot helper that backs the "新会话" dialog: creates the session shell,
 * publishes the opening message via MQTT + Supabase, kicks off runtime spawn
 * for any agents added. The first message intentionally carries no @-mentions
 * (see desktop UX spec — per-agent engagement happens after the user replies
 * inside the session).
 */
export async function createSessionWithFirstMessage(
  args: CreateSessionWithFirstMessageArgs,
): Promise<CreateSessionWithFirstMessageResult> {
  const trimmed = args.messageText.trim()
  if (!trimmed) throw new Error('Opening message cannot be empty')
  sessionFlowLog('session_with_first_message.begin', {
    teamId: args.teamId,
    creatorActorId: args.creatorActorId,
    additionalActorCount: args.additionalActorIds.length,
    agentActorCount: args.agentActorIds.length,
    agentType: args.agentType,
    modelId: args.modelId,
    hasIdeaId: !!args.ideaId,
    ...summarizeText(trimmed),
  })

  const titleSource =
    args.title?.trim() || trimmed.split('\n')[0]?.trim().slice(0, 80) || 'New chat'
  const mentionActorIds = args.mentionActorIds ?? []

  const { sessionId } = await createSessionShell({
    teamId: args.teamId,
    creatorActorId: args.creatorActorId,
    title: titleSource,
    additionalActorIds: args.additionalActorIds,
    ideaId: args.ideaId ?? null,
    ...(args.appId ? { appId: args.appId } : {}),
  })

  const messageId = crypto.randomUUID()
  const createdAt = BigInt(Math.floor(Date.now() / 1000))

  const protoMessage = createProtoMessage(MessageSchema, {
    messageId,
    sessionId,
    senderActorId: args.creatorActorId,
    kind: MessageKind.TEXT,
    content: trimmed,
    createdAt,
    model: args.modelId ?? '',
  })
  const sessionEnvelope = createProtoMessage(SessionMessageEnvelopeSchema, {
    message: protoMessage,
    mentionActorIds,
  })
  const liveEnvelope = createProtoMessage(LiveEventEnvelopeSchema, {
    eventId: crypto.randomUUID(),
    eventType: 'message.created',
    sessionId,
    actorId: args.creatorActorId,
    sentAt: createdAt,
    body: toBinary(SessionMessageEnvelopeSchema, sessionEnvelope),
  })

  try {
    await getBackend().messages.insertOutgoingMessage({
      id: messageId,
      teamId: args.teamId,
      sessionId,
      senderActorId: args.creatorActorId,
      kind: 'text',
      content: trimmed,
      model: args.modelId ?? null,
      metadata: { mention_actor_ids: mentionActorIds },
    })
  } catch (error) {
    sessionFlowError('session_with_first_message.insert_message.failed', error, {
      sessionId,
      teamId: args.teamId,
      messageId,
    })
    throw error
  }
  sessionFlowLog('session_with_first_message.insert_message.ok', {
    sessionId,
    teamId: args.teamId,
    messageId,
  })

  // Publish the opening message to the live topic BEFORE spawning runtimes.
  // The message is already persisted (insertOutgoingMessage above), so the
  // daemon's post-attach catchup query will find it regardless of MQTT
  // ordering; publishing first lets any already-subscribed runtime/client see
  // it without waiting on the (slower) runtimeStart round-trip.
  sessionFlowLog('session_with_first_message.mqtt_publish.begin', {
    sessionId,
    teamId: args.teamId,
    messageId,
    topic: `amux/${args.teamId}/session/${sessionId}/live`,
  })
  await mqttPublish(
    `amux/${args.teamId}/session/${sessionId}/live`,
    toBinary(LiveEventEnvelopeSchema, liveEnvelope),
    false,
  ).catch((publishErr) => {
    sessionFlowError('session_with_first_message.mqtt_publish.failed', publishErr, {
      sessionId,
      teamId: args.teamId,
      messageId,
    })
    console.warn('[session-create] MQTT publish failed (non-fatal):', publishErr)
  })
  sessionFlowLog('session_with_first_message.mqtt_publish.done', {
    sessionId,
    teamId: args.teamId,
    messageId,
  })

  // Fire-and-forget runtime spawn is handled by ChatPanel session_create (and
  // outbox ensure on send). Seeding engaged agents before navigation avoids
  // duplicate runtimeStart from both createSessionWithFirstMessage and send.

  sessionFlowLog('session_with_first_message.ok', {
    sessionId,
    teamId: args.teamId,
    messageId,
  })
  return { sessionId }
}

interface StartAgentRuntimesArgs {
  sessionId: string
  teamId: string
  agentActorIds: string[]
  agentType?: number
  /** Applied to every agent when `modelIdByAgent` has no entry for that id. */
  modelId?: string
  modelIdByAgent?: Record<string, string>
  /**
   * Explicit cloud workspace UUID from send/outbox — highest lookup priority
   * for the **local daemon agent only**. Remote agents ignore this and use
   * their own participant/default/owned workspace lookup.
   */
  workspaceIdHint?: string | null
  rpcTimeoutMs?: number
  /** Suppress workspace-layer toasts; caller surfaces failures. */
  suppressWorkspaceToast?: boolean
  /**
   * When true, skip the post-start setModel fanout. Callers that need an
   * authoritative spawn id (e.g. model-picker) apply the model themselves
   * with the returned `runtimeIdsByAgent` value.
   */
  skipModelApply?: boolean
}

type StartAgentRuntimesResult = {
  failures: RuntimeStartFailure[]
  /** agentActorId → spawn id accepted by the daemon for this batch. */
  runtimeIdsByAgent: Record<string, string>
}

export type RuntimeStartFailureCode =
  | 'device_offline'
  | 'transport_offline'
  | 'workspace_rpc_timeout'
  | 'workspace_ensure_failed'
  /**
   * Adding the agent to `session_participants` failed, so runtimeStart was not
   * attempted.
   *
   * `sessions` carries participant-only RLS (see `joinSession` in the Cloud
   * API's `supabase-repo`, which needs a SECURITY DEFINER RPC precisely to get
   * around it). A daemon that is not a participant therefore cannot read the
   * session it was just asked to start, and its lookup comes back as
   * `fetch_session_with_participants failed: not found: session not found` —
   * a message that points at the wrong thing entirely. This code exists so the
   * real cause is reported instead of that downstream symptom.
   */
  | 'session_participant_failed'
  | 'runtime_rejected'
  | 'backend_session_not_resumable'
  | 'runtime_rpc_failed'
  | 'unknown'

export type RuntimeStartFailure = {
  agentActorId: string
  code: RuntimeStartFailureCode
  reason: string
}

function classifyRuntimeRejection(errorCode: string | undefined): RuntimeStartFailureCode {
  if (errorCode === 'BACKEND_SESSION_NOT_RESUMABLE') {
    return 'backend_session_not_resumable'
  }
  return 'runtime_rejected'
}

function classifyRuntimeRpcError(_error: unknown): RuntimeStartFailureCode {
  return 'runtime_rpc_failed'
}

function normalizeAgentTypes(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((t): t is string => typeof t === 'string' && t.length > 0)
    : []
}

function pickAgentBackend(
  defaultAgentType: string | null | undefined,
  agentTypes: string[],
  priorBackendType: string | null | undefined,
): string | null {
  const normalizedDefault = defaultAgentType === 'claude_code' || defaultAgentType === 'claude-code'
    ? 'claude'
    : defaultAgentType ?? null
  if (normalizedDefault && (agentTypes.length === 0 || agentTypes.includes(normalizedDefault))) {
    return normalizedDefault
  }
  return agentTypes[0] ?? priorBackendType ?? null
}

/**
 * Fire-and-forget RPC fanout. Resolves each agent's cloud workspace id
 * (prior runtime → default_workspace_id → agent-bound workspace), then calls
 * runtimeStart with worktree left empty so the target daemon resolves the
 * local path. Per-agent failures are returned for the caller to surface;
 * unexpected batch-level errors may still throw.
 *
 * The caller is expected to NOT await this — kick it off with `void`.
 * Daemon-published RuntimeInfo retains will update the runtime-state-store
 * asynchronously as the runtimes come up.
 */
export async function startAgentRuntimesAsync(
  args: StartAgentRuntimesArgs,
): Promise<StartAgentRuntimesResult> {
  if (args.agentActorIds.length === 0) return { failures: [], runtimeIdsByAgent: {} }
  const failures: RuntimeStartFailure[] = []
  const runtimeIdsByAgent: Record<string, string> = {}
  const localWorkspacePath = useWorkspaceStore.getState().workspacePath?.trim() || ''
  // The workspace store lags a freshly-opened session — switchToSession
  // resolves the workspace in the background so the view flip stays instant —
  // so prefer the session's own binding, which is written before the session
  // is opened. Without this the first prompt in a just-opened app ran in
  // whatever folder the previous session happened to be using.
  const sessionWorkspacePath = args.sessionId?.trim()
    ? (await resolveSessionWorkspacePath(args.teamId, args.sessionId).catch(() => null))?.trim() ||
      ''
    : ''
  const localWorktree = sessionWorkspacePath || localWorkspacePath
  const rpcTimeoutMs = args.rpcTimeoutMs ?? RUNTIME_START_RPC_TIMEOUT_MS
  let createdByMemberId: string | null = null
  try {
    const userId = useAuthStore.getState().session?.user?.id ?? ''
    createdByMemberId = userId ? await resolveCurrentMemberActorId(args.teamId, userId) : null
  } catch {
    createdByMemberId = null
  }
  sessionFlowLog('runtime_start.batch.begin', {
    sessionId: args.sessionId,
    teamId: args.teamId,
    agentActorIds: args.agentActorIds,
    agentType: args.agentType,
    modelId: args.modelId,
  })

  const agentActorIds = args.agentActorIds

  let localDaemonActorId: string | null = null
  if (isTauri()) {
    try {
      const { getLocalDaemonActorId } = await import('@/lib/daemon-agent-admin')
      localDaemonActorId = await getLocalDaemonActorId()
    } catch {
      localDaemonActorId = null
    }
  }

  const backend = getBackend()
  const priorByAgent = new Map<string, { workspace_id: string | null; backend_type: string | null }>()
  // Prior-runtime hints come off the retain now; there is no lookup to fail,
  // so the fallback path below is unreachable rather than merely unlikely.
  const priorRows = runtimeHintsForAgents(
    agentActorIds,
    useRuntimeStateStore.getState().byRuntimeId,
  )
  for (const r of priorRows) {
    if (!priorByAgent.has(r.agent_id)) {
      priorByAgent.set(r.agent_id, {
        workspace_id: r.workspace_id,
        backend_type: r.backend_type ?? null,
      })
    }
  }

  // Fetch each agent's advertised supported types and default. The default
  // wins over previous runtime history only when it is present in agent_types.
  const defaultByAgent = new Map<string, { agent_types: string[]; default_agent_type: string | null }>()
  let agentRows: Awaited<ReturnType<typeof backend.runtime.listAgentDefaults>> = []
  try {
    agentRows = await backend.runtime.listAgentDefaults(agentActorIds)
  } catch (error) {
    sessionFlowError('runtime_start.lookup_agent_defaults.failed', error, {
      sessionId: args.sessionId,
      teamId: args.teamId,
      agentActorIds: args.agentActorIds,
    })
    console.warn('[session-create] agent defaults lookup failed; continuing with runtime history or fallback values', {
      sessionId: args.sessionId,
      teamId: args.teamId,
      agentActorIds: args.agentActorIds,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
  for (const r of agentRows) {
    defaultByAgent.set(r.id, {
      agent_types: normalizeAgentTypes(r.agent_types),
      default_agent_type: r.default_agent_type ?? null,
    })
  }

  let workspaceLookups: Awaited<ReturnType<typeof loadAgentWorkspaceLookups>> = new Map()
  try {
    workspaceLookups = await loadAgentWorkspaceLookups(args.teamId, args.sessionId, agentActorIds)
  } catch (error) {
    sessionFlowError('runtime_start.lookup_workspace.failed', error, {
      sessionId: args.sessionId,
      teamId: args.teamId,
      agentActorIds,
    })
    console.warn('[session-create] workspace lookup failed; continuing with agent defaults only', {
      sessionId: args.sessionId,
      teamId: args.teamId,
      agentActorIds,
      reason: error instanceof Error ? error.message : String(error),
    })
  }

  await Promise.all(agentActorIds.map(async (agentActorId) => {
    const prior = priorByAgent.get(agentActorId)
    const agentDefaults = defaultByAgent.get(agentActorId)
    const backendType = pickAgentBackend(
      agentDefaults?.default_agent_type,
      agentDefaults?.agent_types ?? [],
      prior?.backend_type,
    )
    const agentType = args.agentType ?? resolveAmuxAgentType(backendType)
    const byRuntimeId = useRuntimeStateStore.getState().byRuntimeId
    const userPick = useAgentModelPickStore.getState().getPick(args.sessionId, agentActorId)
    // Same resolver the send path uses. It used to look only at the live
    // retain for the catalog and never consulted this client's MRU, so on a
    // cold start it answered "no model" for a message the send path had just
    // stamped with a remembered one.
    const { selected: selectedForStart } = resolveAgentSessionModel({
      sessionId: args.sessionId,
      agentId: agentActorId,
      teamId: args.teamId,
      backendType,
      localDaemonActorId,
      explicitModelId: args.modelIdByAgent?.[agentActorId] ?? args.modelId,
    })
    const resolvedModelId = selectedForStart.modelId || undefined

    const isLocalDaemonAgent =
      localDaemonActorId !== null && agentActorId === localDaemonActorId

    const baseLookup = workspaceLookups.get(agentActorId) ?? {}
    const callerHint =
      isLocalDaemonAgent ? args.workspaceIdHint?.trim() || undefined : undefined
    const workspaceLookup = {
      ...baseLookup,
      ...(callerHint ? { callerWorkspaceId: callerHint } : {}),
    }
    let workspaceId = ''
    const sessionWorkspaceId = baseLookup.sessionWorkspaceId?.trim()
    if (callerHint) {
      workspaceId = resolveAgentRuntimeWorkspaceId(workspaceLookup)
    }
    // The session's own workspace binding names the folder this session is
    // for, so it outranks `sessionWorkspaceId` — which records where a PRIOR
    // runtime ran and goes stale the moment the agent runs elsewhere. Opening
    // one app after another, that stale id still named the first app's
    // workspace, and it beat the correct path all the way into the daemon:
    // the second app's agent ran in the first app's checkout.
    if (!workspaceId && isLocalDaemonAgent && sessionWorkspacePath) {
      workspaceId =
        (await resolveCloudWorkspaceIdForLocalPath(args.teamId, sessionWorkspacePath, {
          agentActorId,
        })) ?? ''
    }
    if (!workspaceId && !sessionWorkspaceId && isLocalDaemonAgent && localWorkspacePath) {
      workspaceId =
        (await resolveCloudWorkspaceIdForLocalPath(args.teamId, localWorkspacePath, {
          agentActorId,
        })) ?? ''
    }
    if (!workspaceId) {
      workspaceId = resolveAgentRuntimeWorkspaceId(workspaceLookup)
    }
    if (!workspaceId) {
      workspaceId = await ensureCloudWorkspaceIdForAgentRuntime({
        teamId: args.teamId,
        agentActorId,
        localWorkspacePath: isLocalDaemonAgent ? localWorktree || null : null,
        sessionId: args.sessionId,
        createdByMemberId,
      })
    }

    // The cloud workspace UUID is sent directly to runtimeStart — the target
    // daemon resolves UUID -> local path itself (no client-side daemon
    // pre-registration dance needed).
    const runtimeWorkspaceId = workspaceId

    try {
      sessionFlowLog('runtime_start.request.begin', {
        sessionId: args.sessionId,
        teamId: args.teamId,
        agentActorId,
        agentType,
        modelId: resolvedModelId ?? null,
        userPick: userPick ?? null,
        workspaceId,
        runtimeWorkspaceId,
      })
      // RPC topic is amux/{team}/{agentActorId}/rpc/req — the routing segment
      // is the agent's actor_id.
      const forkFrom = runtimeForkFromForSession(args.sessionId);
      const runtimeStartArgs = {
        targetActorId: agentActorId,
        ...runtimeStartWorkspaceArgs(runtimeWorkspaceId, isLocalDaemonAgent ? localWorktree : ''),
        sessionId: args.sessionId,
        agentType,
        initialPrompt: '',
        ...(resolvedModelId ? { modelId: resolvedModelId } : {}),
        ...(forkFrom ? { forkFrom } : {}),
        timeoutMs: rpcTimeoutMs,
      } as const

      let result = await runtimeStart(runtimeStartArgs)
      if (
        !result.accepted
        && result.errorCode === 'BACKEND_SESSION_NOT_RESUMABLE'
      ) {
        sessionFlowLog('runtime_start.request.reset_binding_retry', {
          sessionId: args.sessionId,
          teamId: args.teamId,
          agentActorId,
        })
        result = await runtimeStart({
          ...runtimeStartArgs,
          resetBackendBinding: true,
        })
      }
      if (!result.accepted) {
        sessionFlowLog('runtime_start.request.rejected', {
          sessionId: args.sessionId,
          teamId: args.teamId,
          agentActorId,
          modelId: args.modelId,
          reason: result.rejectedReason,
        }, 'warn')
        console.error('[session-create] runtimeStart rejected', {
          agentActorId,
          reason: result.rejectedReason,
        })
        failures.push({
          agentActorId,
          code: classifyRuntimeRejection(result.errorCode),
          reason: result.rejectedReason?.trim() || 'runtimeStart rejected',
        })
      } else {
        sessionFlowLog('runtime_start.request.accepted', {
          sessionId: args.sessionId,
          teamId: args.teamId,
          agentActorId,
          runtimeId: result.runtimeId,
          modelId: args.modelId,
        })
        console.info('[session-create] runtimeStart accepted', {
          agentActorId,
          runtimeId: result.runtimeId,
        })
        seedRuntimeStateAfterStart({
          daemonActorId: agentActorId,
          runtimeId: result.runtimeId,
          sessionId: args.sessionId,
          agentType,
        })
        // The seed above cannot include models (they only ride the MQTT retain),
        // and an empty `available_models` pins the session pill at 连接中. For the
        // local daemon we can ask over loopback HTTP instead of waiting on the
        // broker. Fire-and-forget: the retain still wins whenever it lands.
        if (isLocalDaemonAgent && result.runtimeId.trim() && localWorktree) {
          seedLocalDaemonModelsInBackground({
            daemonActorId: agentActorId,
            runtimeId: result.runtimeId.trim(),
            workspacePath: localWorktree,
            backendType,
            sessionId: args.sessionId,
          })
        }
        if (result.runtimeId.trim()) {
          runtimeIdsByAgent[agentActorId] = result.runtimeId.trim()
        }
        const normalizedModelId = resolvedModelId
          ? normalizeAgentModelId(agentActorId, resolvedModelId, byRuntimeId) ??
            resolvedModelId
          : undefined
        if (normalizedModelId && !args.skipModelApply) {
          sessionFlowLog('runtime_start.set_model.begin', {
            sessionId: args.sessionId,
            teamId: args.teamId,
            agentActorId,
            runtimeId: result.runtimeId,
            modelId: normalizedModelId,
            requestedModelId: args.modelId ?? null,
            userPick: userPick ?? null,
          })
          try {
            await setModel({
              targetActorId: agentActorId,
              runtimeId: result.runtimeId,
              modelId: normalizedModelId,
              timeoutMs: rpcTimeoutMs,
            })
            sessionFlowLog('runtime_start.set_model.ok', {
              sessionId: args.sessionId,
              teamId: args.teamId,
              agentActorId,
              runtimeId: result.runtimeId,
              modelId: normalizedModelId,
            })
          } catch (modelErr) {
            sessionFlowError('runtime_start.set_model.failed', modelErr, {
              sessionId: args.sessionId,
              teamId: args.teamId,
              agentActorId,
              runtimeId: result.runtimeId,
              modelId: normalizedModelId,
            })
            console.warn('[session-create] setModel after runtimeStart failed', {
              agentActorId,
              runtimeId: result.runtimeId,
              modelId: normalizedModelId,
              reason: modelErr instanceof Error ? modelErr.message : String(modelErr),
            })
          }
        }
      }
    } catch (e) {
      sessionFlowError('runtime_start.request.failed', e, {
        sessionId: args.sessionId,
        teamId: args.teamId,
        agentActorId,
        modelId: args.modelId,
      })
      console.error('[session-create] runtimeStart threw', {
        agentActorId,
        reason: e instanceof Error ? e.message : String(e),
      })
      failures.push({
        agentActorId,
        code: classifyRuntimeRpcError(e),
        reason: e instanceof Error ? e.message : String(e),
      })
    }
  }))
  sessionFlowLog('runtime_start.batch.done', {
    sessionId: args.sessionId,
    teamId: args.teamId,
    agentActorIds: args.agentActorIds,
    modelId: args.modelId,
    failureCount: failures.length,
  })
  void trackEvent('agent_started', {
    agentCount: args.agentActorIds.length,
    agentType: args.agentType,
    failureCount: failures.length,
  })
  return { failures, runtimeIdsByAgent }
}
