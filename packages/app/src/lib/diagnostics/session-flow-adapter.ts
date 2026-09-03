import { listTraces, recordTrace } from './trace-buffer'
import type { TraceEvent, TraceStage, TraceStatus } from './types'

const TERMINAL_SUFFIXES = new Set(['ok', 'done', 'failed', 'delivered'])
const PAIR_SUFFIXES = new Set(['begin', 'ok', 'done', 'failed', 'delivered'])

const STAGE_PREFIXES: Array<{ prefix: string; stage: TraceStage }> = [
  { prefix: 'outbox_sender.local_runtime_start', stage: 'runtime.start' },
  { prefix: 'outbox_sender.local_ingest', stage: 'local.ingest' },
  { prefix: 'outbox_sender.runtime_ensure', stage: 'runtime.ensure' },
  { prefix: 'outbox_sender.mqtt_publish', stage: 'mqtt.publish' },
  { prefix: 'outbox_sender.message_insert', stage: 'cloud.insert' },
  { prefix: 'outbox_sender.attempt', stage: 'outbox.attempt' },
  { prefix: 'outbox.enqueue', stage: 'send.enqueue' },
  { prefix: 'send.outbox_enqueue', stage: 'send.enqueue' },
  { prefix: 'ensure_runtime_then_set_model', stage: 'runtime.ensure' },
  { prefix: 'ensure_agent_runtime', stage: 'runtime.ensure' },
  { prefix: 'runtime_start', stage: 'runtime.start' },
]

const DETAIL_KEYS = new Set([
  'teamId',
  'agentType',
  'modelId',
  'model',
  'topic',
  'duplicateAlreadyInserted',
  'mentionActorCount',
  'mentionActorIds',
  'agentActorIds',
])

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function lastSegment(stage: string): string {
  const idx = stage.lastIndexOf('.')
  return idx === -1 ? stage : stage.slice(idx + 1)
}

function pairingPrefix(stage: string): string {
  const suffix = lastSegment(stage)
  if (!PAIR_SUFFIXES.has(suffix)) return stage
  return stage.slice(0, -(suffix.length + 1))
}

function mapStage(rawStage: string): TraceStage {
  return STAGE_PREFIXES.find((entry) => rawStage.startsWith(entry.prefix))?.stage ?? 'session.flow'
}

function mapStatus(rawStage: string, level: 'info' | 'warn' | 'error'): TraceStatus {
  const suffix = lastSegment(rawStage)
  if (suffix === 'failed' || level === 'error') return 'error'
  return 'ok'
}

function mapPath(value: unknown): TraceEvent['path'] | undefined {
  return value === 'local_fast' || value === 'remote' ? value : undefined
}

function errorCodeFrom(payload: Record<string, unknown>): string | undefined {
  const error = payload.error
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    return asString(message)
  }
  return asString(payload.error)
}

function safeDetail(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const detail: Record<string, unknown> = {}
  for (const key of DETAIL_KEYS) {
    if (payload[key] !== undefined) detail[key] = payload[key]
  }
  const error = payload.error
  if (error && typeof error === 'object') {
    const rec = error as { name?: unknown; message?: unknown }
    detail.error = { name: rec.name, message: rec.message }
  }
  return Object.keys(detail).length > 0 ? detail : undefined
}

export function adaptSessionFlowLog(
  stage: string,
  payload: Record<string, unknown>,
  level: 'info' | 'warn' | 'error',
): void {
  const messageId = asString(payload.messageId)
  const sessionId = asString(payload.sessionId)
  if (!messageId && !sessionId) return

  const traceId = messageId ?? `session:${sessionId}`
  const suffix = lastSegment(stage)
  const prefix = pairingPrefix(stage)
  const attempt = asFiniteNumber(payload.attemptCount) ?? asFiniteNumber(payload.attempt)
  const now = new Date().toISOString()

  let durationMs: number | undefined
  let pairedAttempt = attempt

  if (TERMINAL_SUFFIXES.has(suffix)) {
    const related = listTraces({ traceId }).filter((event) => pairingPrefix(event.rawStage) === prefix)
    const begins = related.filter((event) => lastSegment(event.rawStage) === 'begin')
    const terminals = related.filter((event) =>
      TERMINAL_SUFFIXES.has(lastSegment(event.rawStage)),
    )
    if (begins.length > terminals.length) {
      const begin = begins[begins.length - 1]
      durationMs = Math.max(0, Date.parse(now) - Date.parse(begin.startedAt))
      pairedAttempt = attempt ?? begin.attempt
    }
  }

  recordTrace({
    traceId,
    sessionId,
    actorId: asString(payload.actorId) ?? asString(payload.senderActorId),
    stage: mapStage(stage),
    rawStage: stage,
    status: mapStatus(stage, level),
    startedAt: now,
    durationMs,
    errorCode: errorCodeFrom(payload),
    attempt: pairedAttempt,
    path: mapPath(payload.path),
    detail: safeDetail(payload),
  })
}
