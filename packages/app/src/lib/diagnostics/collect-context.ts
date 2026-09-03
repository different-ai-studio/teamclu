import type { DaemonHttpProbe } from '@/lib/daemon/daemon-local-client'
import type { DaemonInfoBody, TeamEnvDiagnostics } from '@/lib/diagnostics/diagnostic-report'
import { fetchLocalDaemonCatalog } from '@/lib/agent/local-daemon-model-catalog'
import type { MqttProbeResult } from '@/lib/mqtt/mqtt-probe'
import type { MqttEventSummary } from '@/lib/diagnostics/network-diagnostic-probes'
import type { RuntimeStateSnapshot } from '@/lib/agent/runtime-state-snapshot'
import { AgentStatus, RuntimeLifecycle } from '@/lib/proto/amux_pb'
import { useOutboxStore } from '@/stores/outbox-store'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'
import { useWorkspaceStore } from '@/stores/workspace'
import { useCurrentTeamStore } from '@/stores/current-team'
import { listTraces } from './trace-buffer'
import type { DiagnosticContext } from './types'

async function collectCatalog() {
  try {
    const workspacePath = useWorkspaceStore.getState().workspacePath?.trim()
    if (!workspacePath) return { status: 'unknown' as const }
    return await fetchLocalDaemonCatalog(workspacePath)
  } catch {
    return { status: 'unknown' as const }
  }
}

async function collectTeamLlm(): Promise<DiagnosticContext['teamLlm']> {
  try {
    const teamId = useCurrentTeamStore.getState().team?.id
    if (!teamId) return null
    const { getBackend } = await import('@/lib/backend')
    const llm = await getBackend().teamWorkspaceConfig.loadLlmConfig(teamId)
    if (!llm) return null
    return { enabled: llm.enabled, baseUrl: llm.baseUrl }
  } catch {
    return null
  }
}

function collectRuntimeActivity(): DiagnosticContext['runtimeActivity'] {
  const entries = Object.values(useRuntimeStateStore.getState().byRuntimeId)
  if (entries.length === 0) return { active: null, lastTurnError: null }
  const active = entries.some(
    (entry) =>
      entry.info.status === AgentStatus.ACTIVE ||
      entry.info.state === RuntimeLifecycle.ACTIVE,
  )
  const failed = entries.find(
    (entry) =>
      entry.info.status === AgentStatus.ERROR ||
      Boolean(entry.info.errorMessage) ||
      Boolean(entry.info.errorCode),
  )
  return {
    active,
    lastTurnError: failed?.info.errorMessage?.trim() || failed?.info.errorCode?.trim() || null,
  }
}

export async function collectDiagnosticContext(input: {
  online: boolean | null
  daemonProbe: DaemonHttpProbe
  daemonInfo: DaemonInfoBody | null
  daemonLiveConnected: boolean
  mqttDesktopConnected: boolean | null
  mqttDesktopLastError: string | null
  mqttSubscribedTopicCount: number
  mqttProbe: MqttProbeResult | null
  mqttEventSummary: MqttEventSummary
  cloudReachable: boolean
  bootstrapStatus: number | null
  auth: DiagnosticContext['auth']
  teamEnv: TeamEnvDiagnostics | null
  runtimeState: RuntimeStateSnapshot | null
}): Promise<DiagnosticContext> {
  const [catalog, teamLlm] = await Promise.all([collectCatalog(), collectTeamLlm()])
  const outbox = Object.values(useOutboxStore.getState().byId).map((entry) => ({
    messageId: entry.messageId,
    sessionId: entry.sessionId,
    state: entry.state,
    lastError: entry.lastError,
    attemptCount: entry.attemptCount,
    updatedAt: entry.updatedAt,
  }))

  return {
    online: input.online,
    daemon: {
      reachable: input.daemonProbe.ok,
      probeReason: input.daemonProbe.ok ? undefined : input.daemonProbe.reason,
      info: input.daemonInfo,
      liveConnected: input.daemonLiveConnected,
    },
    catalog,
    teamLlm,
    outbox,
    traces: listTraces(),
    mqtt: {
      desktopConnected: input.mqttDesktopConnected,
      desktopLastError: input.mqttDesktopLastError,
      subscribedTopicCount: input.mqttSubscribedTopicCount,
      daemonConnected: input.daemonInfo?.mqtt_connected,
      probe: input.mqttProbe,
      eventSummary: input.mqttEventSummary,
    },
    cloud: {
      reachable: input.cloudReachable,
      bootstrapStatus: input.bootstrapStatus,
    },
    auth: input.auth,
    teamEnv: input.teamEnv,
    runtimeState: input.runtimeState,
    runtimeActivity: collectRuntimeActivity(),
  }
}
