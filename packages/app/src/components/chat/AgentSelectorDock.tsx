import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ModelPickerCommand } from '@/components/model/ModelPickerCommand'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'
import { useLocalDaemonCatalogStore } from '@/stores/local-daemon-catalog-store'
import { resolveAutoPersistModelId } from '@/lib/agent-model-auto-persist'
import { useWorkspaceStore } from '@/stores/workspace'
import {
  resolveAgentCatalogModels,
  localRecentModelFallback,
  recordClientModelPick,
} from '@/lib/agent-model-fallback'
import { resolveSessionEstablishedModel } from '@/lib/session-established-model'
import { sessionFlowError, sessionFlowLog } from '@/lib/session-flow-log'
import { RuntimeLifecycle, type RuntimeInfo } from '@/lib/proto/amux_pb'
import {
  backendTypeFromRuntimeEntry,
  agentModelDisplayLabel,
  isAgentModelRowSelected,
  resolveRuntimeStateEntryForAgent,
  resolveSetModelId,
  selectAgentModel,
} from '@/lib/runtime-state-resolve'
import { ensureRuntimeThenSetModel } from '@/lib/teamclu/ensure-agent-runtime'
import {
  DRAFT_SESSION_PICK_KEY,
  useAgentModelPickStore,
} from '@/stores/agent-model-pick-store'
import { useSessionSelectionStore } from '@/stores/session-selection-store'
import { useSessionMessageStore } from '@/stores/session-message-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { clientMruModels } from '@/stores/client-model-mru'
import { useSessionListStore } from '@/stores/session-list-store'
import { useLocalDaemonActorId } from '@/lib/daemon-agent-admin'
import { getKnownLocalDaemonActorId } from '@/lib/local-daemon-identity'
import { cn } from '@/lib/utils'
import type { AttachedAgent } from '@/packages/ai/prompt-input-insert-hooks'
import type { EngagedAgentUiEntry } from '@/hooks/use-engaged-agent-ui-states'
import {
  resolveAgentPillDot,
  type SessionAgentSyncHint,
  type SessionAgentUiState,
} from '@/lib/session-agent-ui-state'
import { pillSuffixForAgentPill } from '@/components/chat/EngagedAgentOfflineBanner'
import { isSoloBuild } from '@/lib/solo-build'

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface AgentSelectorDockProps {
  /** The session currently displayed by ChatPanel. */
  activeSessionId: string | null
  /** All agents currently @-mentioned for the active session — one pill each. */
  engagedAgents: AttachedAgent[]
  /** Precomputed in ChatPanel — shared with banner / send confirm. */
  engagedUiEntries: EngagedAgentUiEntry[]
  agentToRuntimeId: Map<string, string>
  agentToBackendType: Map<string, string>
  /** Remove a single agent (clicked the X on the chip / "Remove" in dropdown). */
  onRemoveAgent: (agentId: string) => void
  /** Solo session: agent pill is mandatory and cannot be removed. */
  agentMentionLocked?: boolean
}

export { resolveAgentAvailableModels } from '@/lib/agent-available-models'

// ────────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────────

export function AgentSelectorDock({
  activeSessionId,
  engagedAgents,
  engagedUiEntries,
  agentToRuntimeId,
  agentToBackendType,
  onRemoveAgent,
  agentMentionLocked = false,
}: AgentSelectorDockProps) {
  const runtimeStates = useRuntimeStateStore((s) => s.byRuntimeId)
  const uiEntryByAgentId = React.useMemo(
    () => new Map(engagedUiEntries.map((e) => [e.agent.id, e])),
    [engagedUiEntries],
  )

  if (engagedAgents.length === 0) return null

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
      {engagedAgents.map((agent) => {
        const dbRuntimeId = agentToRuntimeId.get(agent.id)
        const runtimeEntry = resolveRuntimeStateEntryForAgent(
          agent.id,
          runtimeStates,
          dbRuntimeId,
        )
        const backendType = backendTypeFromRuntimeEntry(
          runtimeEntry,
          agentToBackendType.get(agent.id),
        )
        return (
          <AgentPill
            key={agent.id}
            sessionIdProp={activeSessionId}
            agent={agent}
            dbRuntimeId={dbRuntimeId}
            backendType={backendType}
            runtimeInfo={runtimeEntry?.info}
            uiState={uiEntryByAgentId.get(agent.id)?.uiState ?? 'connecting'}
            syncHint={uiEntryByAgentId.get(agent.id)?.syncHint ?? null}
            mentionLocked={agentMentionLocked}
            onRemove={() => {
              if (activeSessionId) {
                useAgentModelPickStore.getState().clearPick(activeSessionId, agent.id)
              }
              onRemoveAgent(agent.id)
            }}
          />
        )
      })}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Per-agent pill
// ────────────────────────────────────────────────────────────────────────────

function AgentPill({
  sessionIdProp,
  agent,
  dbRuntimeId,
  backendType,
  runtimeInfo,
  uiState,
  syncHint = null,
  mentionLocked = false,
  onRemove,
}: {
  sessionIdProp: string | null
  agent: AttachedAgent
  dbRuntimeId: string | undefined
  backendType: string | undefined
  runtimeInfo: RuntimeInfo | undefined
  uiState: SessionAgentUiState
  syncHint?: SessionAgentSyncHint
  mentionLocked?: boolean
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)

  const localActorId = useLocalDaemonActorId()
  const isSelf = !!localActorId && agent.id === localActorId
  const byRuntimeId = useRuntimeStateStore((s) => s.byRuntimeId)
  const sessionId =
    sessionIdProp?.trim() ||
    useSessionSelectionStore.getState().activeSessionId?.trim() ||
    ''
  // A new chat is draft-first: the pill is live before the session exists. Picks
  // still need somewhere to land, or choosing a model is a no-op until after the
  // first send. Promoted onto the real id by `promoteDraftPicks` on create.
  const pickScopeId = sessionId || DRAFT_SESSION_PICK_KEY

  const liveRuntimeEntry = React.useMemo(
    () => resolveRuntimeStateEntryForAgent(agent.id, byRuntimeId, dbRuntimeId),
    [agent.id, byRuntimeId, dbRuntimeId],
  )
  const liveRuntimeInfo = liveRuntimeEntry?.info ?? runtimeInfo
  const effectiveUiState: SessionAgentUiState = uiState
  const { color: dotColor, pulse } = resolveAgentPillDot(effectiveUiState, liveRuntimeInfo)

  // Loopback catalog for THIS device. Only ever consulted for the local agent —
  // a remote agent's models can only come from its own retain.
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)?.trim() || ''
  const localCatalog = useLocalDaemonCatalogStore((s) =>
    isSelf && workspacePath ? s.byWorkspacePath[workspacePath] : undefined,
  )
  const remoteDefaultCatalog = useRuntimeStateStore(
    (s) => s.defaultCatalogByActorId?.[agent.id],
  )

  const availableModels = React.useMemo(
    () =>
      resolveAgentCatalogModels({
        agentId: agent.id,
        localDaemonActorId: localActorId,
        sessionId,
        byRuntimeId,
        runtimeInfo: liveRuntimeInfo,
        localWorkspaceCatalogModels: localCatalog?.models,
        remoteDefaultCatalogModels: remoteDefaultCatalog?.models,
      }),
    [
      agent.id,
      localActorId,
      sessionId,
      byRuntimeId,
      liveRuntimeInfo,
      localCatalog,
      remoteDefaultCatalog,
    ],
  )

  const statusSuffix = pillSuffixForAgentPill(effectiveUiState, syncHint, t)
  const hideModelOnPill = isSoloBuild()
  // `unconfigured` is a settled answer ("nothing to run"), so it must not read
  // as loading — that is the spinner-forever bug this state exists to end.
  const runtimeInfoLoading =
    effectiveUiState === 'connecting' &&
    availableModels.length === 0 &&
    localCatalog?.status !== 'empty' &&
    (!liveRuntimeInfo || liveRuntimeInfo.state === RuntimeLifecycle.STARTING)
  // Subscribe to the pick entry so explicit user picks immediately drive the
  // pill — selectAgentModel reads the same store but via getState() and would
  // otherwise miss a re-render trigger.
  const pickEntry = useAgentModelPickStore((s) =>
    s.bySessionAgent[`${pickScopeId}::${agent.id}`],
  )
  // The model this session already ran with, from its transcript. Empty for
  // brand-new sessions, so they keep the last-pick default.
  const sessionEstablishedModel = useSessionMessageStore((s) =>
    sessionId ? resolveSessionEstablishedModel(s.messages[sessionId], agent.id) : null,
  )

  // This device's last-used model, from the loopback catalog's MRU. Sits in the
  // `providerFallback` slot: below an explicit pick, the session transcript and
  // the live retain, above "just take availableModels[0]". Local agent only —
  // this device's history says nothing about a remote agent's.
  const localRecentModel = React.useMemo(
    () =>
      localRecentModelFallback({
        agentId: agent.id,
        localDaemonActorId: localActorId,
        // This client's MRU, not the daemon's (ADR-0007). `localCatalog` still
        // supplies the catalog itself — only the history moved.
        // No explicit team: the pill only needs one for its own label, and
        // `current-team` no longer blanks itself while auth restores (see
        // `current-team.ts`), so the store answer is good here.
        recentModels: clientMruModels(backendType),
        available: availableModels,
      }),
    [agent.id, localActorId, backendType, availableModels],
  )

  const selected = React.useMemo(
    () =>
      selectAgentModel({
        sessionId: pickScopeId,
        agentId: agent.id,
        available: availableModels,
        byRuntimeId,
        sessionEstablishedModel,
        providerFallback: localRecentModel || undefined,
      }),
    [
      pickScopeId,
      agent.id,
      availableModels,
      byRuntimeId,
      sessionEstablishedModel,
      localRecentModel,
      // Force recompute when the pick changes — pickEntry is referenced for
      // the dependency hint; selectAgentModel reads from store.getState().
      pickEntry?.modelId,
    ],
  )
  const effectiveModelId = selected.modelId
  const displayedModel =
    availableModels.find((m) => m.id === effectiveModelId)?.displayName ||
    (effectiveModelId
      ? agentModelDisplayLabel(effectiveModelId, availableModels)
      : '') ||
    (runtimeInfoLoading ? '' : availableModels[0]?.displayName || availableModels[0]?.id || '')
  // Pill shows user pick or live retain; list[0] is only a loading placeholder.
  const isPlaceholderModel = selected.source === 'none' && !!displayedModel

  const displayRuntimeId = liveRuntimeInfo?.runtimeId?.trim() || dbRuntimeId

  React.useEffect(() => {
    sessionFlowLog('agent_selector.model_options.resolved', {
      agentId: agent.id,
      agentName: agent.displayName,
      runtimeId: displayRuntimeId,
      backendType,
      runtimeCurrentModel: liveRuntimeInfo?.currentModel ?? null,
      runtimeAvailableModelIds: liveRuntimeInfo?.availableModels.map((m) => m.id) ?? [],
      resolvedModelIds: availableModels.map((m) => m.id),
      runtimeInfoLoading,
    })
  }, [
    agent.id,
    agent.displayName,
    displayRuntimeId,
    backendType,
    liveRuntimeInfo?.currentModel,
    liveRuntimeInfo?.availableModels,
    availableModels,
    runtimeInfoLoading,
  ])

  // Catalog is visible but nothing was user-/runtime-selected. Persist a
  // session pick so reload/send keep a real id (and the dropdown shows a
  // checkmark).
  //
  // What gets persisted matters more than it looks: a pick outranks every
  // other level in `selectAgentModel`, so whatever lands here wins for good.
  // Writing `availableModels[0]` unconditionally is what made a restart snap
  // back to the first model — on a cold start the retain has not arrived, so
  // `currentModel` is empty, and this effect would durably pin model[0] over
  // the model the device actually last used. Prefer this device's MRU and fall
  // back to first-advertised only when there is no history to honour.
  React.useEffect(() => {
    const chosenId = resolveAutoPersistModelId({
      sessionId: pickScopeId,
      uiState: effectiveUiState,
      runtimeInfoLoading,
      availableModelIds: availableModels.map((m) => m.id),
      existingPick: useAgentModelPickStore.getState().getPick(pickScopeId, agent.id),
      sessionEstablishedModel,
      retainCurrentModel: liveRuntimeInfo?.currentModel,
      // The hook is async and reads null on the first renders; the persisted
      // id answers synchronously so a local agent is recognised as local from
      // render 1 and the MRU guard actually applies.
      localDaemonActorId: localActorId ?? getKnownLocalDaemonActorId(),
      agentId: agent.id,
      localCatalogStatus: localCatalog?.status,
      localRecentModel,
    })
    if (!chosenId) return
    const rpcModelId = resolveSetModelId(agent.id, chosenId, byRuntimeId)
    sessionFlowLog('agent_selector.model_auto_select', {
      agentId: agent.id,
      sessionId: pickScopeId,
      modelId: rpcModelId,
      source: localRecentModel ? 'device_mru' : 'first_advertised',
      availableModelIds: availableModels.map((m) => m.id),
    })
    useAgentModelPickStore.getState().setPick(pickScopeId, agent.id, rpcModelId)
  }, [
    pickScopeId,
    agent.id,
    effectiveUiState,
    runtimeInfoLoading,
    availableModels,
    sessionEstablishedModel,
    liveRuntimeInfo?.currentModel,
    byRuntimeId,
    isSelf,
    localActorId,
    localCatalog,
    localRecentModel,
  ])

  const handlePickModel = React.useCallback(async (modelId: string) => {
    const freshByRuntimeId = useRuntimeStateStore.getState().byRuntimeId
    const rpcModelId = resolveSetModelId(agent.id, modelId, freshByRuntimeId)
    const teamId =
      useSessionListStore.getState().rows.find((r) => r.id === sessionId)?.team_id ??
      useCurrentTeamStore.getState().team?.id ??
      null

    sessionFlowLog('agent_selector.model_pick.begin', {
      agentId: agent.id,
      agentName: agent.displayName,
      dbRuntimeId,
      teamId,
      effectiveModelId,
      modelId,
      rpcModelId,
      availableModelIds: availableModels.map((m) => m.id),
    })

    // Store the pick FIRST. Survives reload; MQTT retains cannot override it.
    // On a draft chat this writes the draft scope, so the dropdown reflects the
    // choice immediately and `promoteDraftPicks` carries it onto the session.
    useAgentModelPickStore.getState().setPick(pickScopeId, agent.id, rpcModelId)

    // ...and remember it as this client's MRU, so the NEXT new chat starts
    // here (ADR-0007). Only this path records. The auto-select above must not:
    // writing a cold-start guess down turns it into a preference that outlives
    // the guess, which is the loop this migration exists to break.
    recordClientModelPick({
      agentId: agent.id,
      localDaemonActorId: localActorId,
      backendType,
      teamId,
      modelId: rpcModelId,
    })

    if (!sessionId || !teamId) {
      sessionFlowLog('agent_selector.model_pick.deferred_until_session', {
        agentId: agent.id,
        modelId,
        sessionId,
        pickScopeId,
        teamId,
      })
      return
    }

    // Ask daemon for the live spawn (runtimeStart, with dedup), then setModel
    // with that authoritative id — never guess from MQTT/DB hints.
    try {
      const { runtimeId } = await ensureRuntimeThenSetModel({
        sessionId,
        teamId,
        agentActorId: agent.id,
        modelId: rpcModelId,
      })
      sessionFlowLog('agent_selector.model_pick.ok', {
        agentId: agent.id,
        runtimeId,
        modelId: rpcModelId,
        sessionId,
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      sessionFlowError('agent_selector.model_pick.failed', e, {
        agentId: agent.id,
        modelId: rpcModelId,
        sessionId,
        teamId,
      })
      const { toast } = await import('sonner')
      toast.error(t('chat.agentSelector.modelChangeFailed', 'Failed to change model'), {
        description: t(
          'chat.agentSelector.modelChangeWillRetry',
          '选择已保存，将在下次发送消息时重新应用。详情: {{message}}',
          { message },
        ),
      })
      console.error('[AgentSelectorDock] ensureRuntimeThenSetModel failed (pick preserved)', e)
    }
  }, [agent.id, agent.displayName, dbRuntimeId, sessionId, pickScopeId, t, effectiveModelId, availableModels, backendType, localActorId])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            'h-7 min-w-0 max-w-full gap-1 overflow-hidden rounded-full bg-muted/40 px-2 text-xs font-medium',
            effectiveUiState === 'stale' && 'border border-dashed border-border',
          )}
        >
          <span
            className={cn(
              'h-2 w-2 shrink-0 rounded-full',
              dotColor,
              pulse && 'animate-pulse',
            )}
          />
          {isSelf ? null : <span className="min-w-0 truncate">{agent.displayName}</span>}
          {statusSuffix ? (
            <>
              {isSelf ? null : <span className="shrink-0 text-muted-foreground/70">·</span>}
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-[11px]',
                  syncHint === 'degraded' ? 'text-amber-600' : 'text-faint',
                )}
              >
                {effectiveUiState === 'connecting' &&
                (runtimeInfoLoading || availableModels.length === 0) ? (
                  <span className="inline-flex items-center gap-1">
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                    {statusSuffix}
                  </span>
                ) : (
                  statusSuffix
                )}
              </span>
            </>
          ) : hideModelOnPill ? null : runtimeInfoLoading && !displayedModel ? (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
          ) : displayedModel ? (
            <>
              {isSelf ? null : <span className="shrink-0 text-muted-foreground/70">·</span>}
              <span
                className={cn(
                  'min-w-0 flex-1 truncate font-mono text-[11px]',
                  isPlaceholderModel
                    ? 'italic text-muted-foreground/50'
                    : 'text-muted-foreground',
                )}
                title={isPlaceholderModel
                  ? t('chat.agentSelector.placeholderModelHint', 'No live runtime — dropdown will default to this model')
                  : undefined}
              >
                {displayedModel}
              </span>
            </>
          ) : null}
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[18rem] p-0"
      >
        <ModelPickerCommand
          models={availableModels}
          isSelected={(id) => isAgentModelRowSelected(id, effectiveModelId)}
          onSelect={(id) => {
            setOpen(false)
            void handlePickModel(id)
          }}
          overrideContent={
            effectiveUiState === 'offline' || effectiveUiState === 'stale' ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">
                {effectiveUiState === 'stale'
                  ? t('chat.sessionAgent.dropdownStale')
                  : t('chat.sessionAgent.dropdownOffline')}
              </div>
            ) : effectiveUiState === 'runtime-error' ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">
                {t('chat.sessionAgent.dropdownRuntimeError', 'Agent failed to start — retry the connection')}
              </div>
            ) : effectiveUiState === 'unconfigured' ? (
              // Point at the fix rather than the generic "no models advertised",
              // which reads like a fault when it is just an unfinished setup.
              <div className="px-2 py-3 text-xs text-muted-foreground">
                {t(
                  'chat.sessionAgent.dropdownUnconfigured',
                  'No model provider configured yet — add one in Settings to start chatting',
                )}
              </div>
            ) : runtimeInfoLoading ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">
                {t('chat.agentSelector.loading', 'Loading…')}
              </div>
            ) : null
          }
          emptyState={
            <div className="px-2 py-3 text-xs text-muted-foreground">
              {t('chat.agentSelector.noModels', 'No models advertised')}
            </div>
          }
          footer={
            mentionLocked ? undefined : (
            <div className="p-1">
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  onRemove()
                }}
                className="flex w-full items-center rounded-sm px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 focus:bg-destructive/10 focus:outline-none"
              >
                <X className="h-3.5 w-3.5 mr-1.5" />
                {t('chat.agentSelector.removeMention', 'Remove mention')}
              </button>
            </div>
            )
          }
        />
      </PopoverContent>
    </Popover>
  )
}
