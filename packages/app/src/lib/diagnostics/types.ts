import type { LocalDaemonCatalogOutcome } from '@/lib/local-daemon-model-catalog'
import type { MqttProbeResult } from '@/lib/mqtt-probe'
import type { MqttEventSummary } from '@/lib/network-diagnostic-probes'
import type { RuntimeStateSnapshot } from '@/lib/runtime-state-snapshot'
import type { OutboxEntry } from '@/stores/outbox-store'
import type { SettingsSection } from '@/stores/ui'

export interface DiagnosticDaemonInfo {
  configured_agent_types?: string[]
  cloud_auth?: { status?: string }
  mqtt_connected?: boolean
}

export interface DiagnosticTeamEnv {
  teamIdPresent: boolean
  linkExists: boolean
  targetAccessible: boolean
}

export type TraceStatus = 'ok' | 'error' | 'timeout' | 'skipped'

export type TraceStage =
  | 'send.enqueue'
  | 'outbox.attempt'
  | 'cloud.insert'
  | 'mqtt.publish'
  | 'runtime.ensure'
  | 'runtime.start'
  | 'local.ingest'
  | 'agent.turn'
  | 'session.flow'

export interface TraceEvent {
  traceId: string
  sessionId?: string
  actorId?: string
  stage: TraceStage
  rawStage: string
  status: TraceStatus
  startedAt: string
  durationMs?: number
  errorCode?: string
  attempt?: number
  path?: 'local_fast' | 'remote'
  detail?: Record<string, unknown>
}

export type FindingStatus = 'ok' | 'warn' | 'fail'
export type FindingConfidence = 'high' | 'medium' | 'low'
export type DiagnosticSymptom = 'model' | 'send' | 'realtime' | 'auth_sync'

export type DiagnosticCauseCode =
  | 'model.daemon_unreachable'
  | 'model.provider_not_configured'
  | 'model.backend_probe_failed'
  | 'model.catalog_ok'
  | 'model.catalog_unknown'
  | 'model.team_gateway_unconfigured'
  | 'send.outbox_failed'
  | 'send.cloud_insert_failed'
  | 'send.mqtt_publish_failed'
  | 'send.runtime_ensure_failed'
  | 'send.local_ingest_failed'
  | 'send.delivered_no_turn'
  | 'send.path_ok'
  | 'agent.turn_timeout'
  | 'agent.model_provider_error'
  | 'agent.runtime_inactive'
  | 'realtime.mqtt_auth_failed'
  | 'realtime.mqtt_network_failed'
  | 'realtime.mqtt_desktop_only'
  | 'realtime.mqtt_daemon_only'
  | 'realtime.sse_fallback'
  | 'realtime.topic_empty'
  | 'realtime.ok'
  | 'auth.session_invalid'
  | 'auth.daemon_cloud_expired'
  | 'sync.team_link_broken'

export interface DiagnosticEvidence {
  source:
    | 'daemon.info'
    | 'daemon.healthz'
    | 'daemon.catalog'
    | 'outbox'
    | 'trace'
    | 'mqtt.probe'
    | 'mqtt.snapshot'
    | 'cloud.api'
    | 'runtime.state'
  summary: string
  at?: string
  data?: Record<string, unknown>
}

export interface DiagnosticFinding {
  code: DiagnosticCauseCode
  symptom: DiagnosticSymptom
  status: FindingStatus
  confidence: FindingConfidence
  title: string
  message: string
  nextAction: string
  evidence: DiagnosticEvidence[]
  hintSection?: SettingsSection
}

export interface DiagnosticOutboxSnapshot {
  messageId: string
  sessionId: string
  state: OutboxEntry['state']
  lastError: string | null
  attemptCount: number
  updatedAt: string
}

export interface DiagnosticContext {
  online: boolean | null
  daemon: {
    reachable: boolean
    probeReason?: string
    info: DiagnosticDaemonInfo | null
    liveConnected: boolean
  }
  catalog: LocalDaemonCatalogOutcome | null
  teamLlm: { enabled: boolean; baseUrl: string | null } | null
  outbox: DiagnosticOutboxSnapshot[]
  traces: TraceEvent[]
  mqtt: {
    desktopConnected: boolean | null
    desktopLastError: string | null
    subscribedTopicCount: number
    daemonConnected: boolean | undefined
    probe: MqttProbeResult | null
    eventSummary: MqttEventSummary
  }
  cloud: {
    reachable: boolean
    bootstrapStatus: number | null
  }
  auth: {
    hasSession: boolean
    tokenExpired: boolean
    secondsUntilExpiry: number | null
  }
  teamEnv: DiagnosticTeamEnv | null
  runtimeState: RuntimeStateSnapshot | null
  runtimeActivity: {
    active: boolean | null
    lastTurnError: string | null
  }
}
