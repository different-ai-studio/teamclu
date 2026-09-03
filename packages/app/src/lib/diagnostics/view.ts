import type {
  DiagnosticFinding,
  FindingConfidence,
  FindingStatus,
  TraceEvent,
  TraceStage,
} from './types'

export type SymptomTab = 'model' | 'send' | 'realtime'

export type SendStripStatus = 'idle' | 'ok' | 'error'

export interface SendStripStage {
  id: 'enqueue' | 'cloud' | 'mqtt' | 'runtime' | 'turn'
  label: string
  status: SendStripStatus
}

const STATUS_RANK: Record<FindingStatus, number> = { ok: 0, warn: 1, fail: 2 }
const CONFIDENCE_RANK: Record<FindingConfidence, number> = { low: 0, medium: 1, high: 2 }

const SEND_STAGES = new Set<TraceStage>([
  'send.enqueue',
  'outbox.attempt',
  'cloud.insert',
  'mqtt.publish',
  'runtime.ensure',
  'runtime.start',
  'local.ingest',
  'agent.turn',
])

const STRIP_STAGES: Array<{ id: SendStripStage['id']; label: string; stages: TraceStage[] }> = [
  { id: 'enqueue', label: '入队', stages: ['send.enqueue', 'outbox.attempt'] },
  { id: 'cloud', label: 'Cloud', stages: ['cloud.insert'] },
  { id: 'mqtt', label: 'MQTT', stages: ['mqtt.publish', 'local.ingest'] },
  { id: 'runtime', label: 'Runtime', stages: ['runtime.ensure', 'runtime.start'] },
  { id: 'turn', label: 'Turn', stages: ['agent.turn'] },
]

export function findingsForSymptom(
  findings: DiagnosticFinding[],
  symptom: SymptomTab,
): DiagnosticFinding[] {
  return findings.filter((item) => item.symptom === symptom)
}

export function primaryFinding(
  findings: DiagnosticFinding[],
  symptom: SymptomTab,
): DiagnosticFinding | null {
  const list = findingsForSymptom(findings, symptom)
  if (list.length === 0) return null
  return [...list].sort((a, b) => {
    const status = STATUS_RANK[b.status] - STATUS_RANK[a.status]
    if (status !== 0) return status
    return CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence]
  })[0]
}

export function tracesForSession(traces: TraceEvent[], sessionId: string): TraceEvent[] {
  return traces.filter((event) => event.sessionId === sessionId)
}

export function tracesForSymptom(traces: TraceEvent[], symptom: SymptomTab): TraceEvent[] {
  if (symptom === 'send') return traces.filter((event) => SEND_STAGES.has(event.stage))
  if (symptom === 'model') {
    return traces.filter((event) => event.stage === 'runtime.start')
  }
  return traces.filter((event) => event.stage === 'mqtt.publish')
}

export function sendStageStrip(traces: TraceEvent[]): SendStripStage[] {
  return STRIP_STAGES.map((stage) => {
    const hits = traces.filter((event) => stage.stages.includes(event.stage))
    let status: SendStripStatus = 'idle'
    if (hits.some((event) => event.status === 'error')) status = 'error'
    else if (hits.some((event) => event.status === 'ok' && !event.rawStage.endsWith('.begin'))) {
      status = 'ok'
    }
    return { id: stage.id, label: stage.label, status }
  })
}

export function worstFindingStatus(findings: DiagnosticFinding[]): FindingStatus | null {
  if (findings.length === 0) return null
  return findings.reduce<FindingStatus>((worst, item) => {
    return STATUS_RANK[item.status] > STATUS_RANK[worst] ? item.status : worst
  }, 'ok')
}

export function firstFailingTab(findings: DiagnosticFinding[]): SymptomTab {
  const order: SymptomTab[] = ['model', 'send', 'realtime']
  return order.find((tab) => findingsForSymptom(findings, tab).some((item) => item.status === 'fail'))
    ?? order.find((tab) => findingsForSymptom(findings, tab).some((item) => item.status === 'warn'))
    ?? 'model'
}

export function authSyncFindings(findings: DiagnosticFinding[]): DiagnosticFinding[] {
  return findings.filter((item) => item.symptom === 'auth_sync')
}
