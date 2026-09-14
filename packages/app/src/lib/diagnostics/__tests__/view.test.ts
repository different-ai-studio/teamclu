import { describe, expect, it } from 'vitest'
import {
  findingsForSessionFocus,
  findingsForSymptom,
  primaryFinding,
  sendStageStrip,
  scopeDiagnosticContext,
  tracesForSession,
  tracesForSymptom,
} from '../view'
import type { DiagnosticFinding, TraceEvent } from '../types'

function finding(overrides: Partial<DiagnosticFinding>): DiagnosticFinding {
  return {
    code: 'model.catalog_ok',
    symptom: 'model',
    status: 'ok',
    confidence: 'high',
    title: '模型目录',
    message: 'ok',
    nextAction: '无需处理',
    evidence: [],
    ...overrides,
  }
}

function trace(overrides: Partial<TraceEvent>): TraceEvent {
  return {
    traceId: 'm1',
    sessionId: 's1',
    stage: 'outbox.attempt',
    rawStage: 'outbox_sender.attempt.delivered',
    status: 'ok',
    startedAt: '2026-09-03T00:00:00.000Z',
    ...overrides,
  }
}

describe('diagnostics view helpers', () => {
  it('picks the worst finding for a symptom as the conclusion', () => {
    const findings = [
      finding({ code: 'model.catalog_ok', status: 'ok' }),
      finding({
        code: 'model.backend_probe_failed',
        status: 'fail',
        message: 'provider auth token invalid',
      }),
      finding({ code: 'realtime.ok', symptom: 'realtime', status: 'ok' }),
    ]
    expect(primaryFinding(findings, 'model')?.code).toBe('model.backend_probe_failed')
    expect(findingsForSymptom(findings, 'model')).toHaveLength(2)
    expect(findingsForSymptom(findings, 'realtime')).toHaveLength(1)
  })

  it('filters traces by session and by send stages', () => {
    const traces = [
      trace({ sessionId: 's1', stage: 'mqtt.publish' }),
      trace({ sessionId: 's2', stage: 'mqtt.publish', traceId: 'm2' }),
      trace({ sessionId: 's1', stage: 'session.flow', rawStage: 'send.optimistic_append' }),
    ]
    expect(tracesForSession(traces, 's1')).toHaveLength(2)
    expect(tracesForSymptom(traces, 'send').map((e) => e.sessionId)).toEqual(['s1', 's2'])
  })

  it('scopes traces and outbox to one session', () => {
    const scoped = scopeDiagnosticContext(
      {
        traces: [
          trace({ sessionId: 's1' }),
          trace({ sessionId: 's2', traceId: 'm2' }),
        ],
        outbox: [
          { sessionId: 's1', messageId: 'a' },
          { sessionId: 's2', messageId: 'b' },
        ],
      },
      's1',
    )
    expect(scoped.traces.map((event) => event.sessionId)).toEqual(['s1'])
    expect(scoped.outbox.map((entry) => entry.messageId)).toEqual(['a'])
  })

  it('drops send findings that belong to another session', () => {
    const findings = [
      finding({
        code: 'send.outbox_failed',
        symptom: 'send',
        message: 'other session boom',
        evidence: [{ source: 'outbox', summary: 'm2 failed', data: { sessionId: 's2' } }],
      }),
      finding({
        code: 'send.mqtt_publish_failed',
        symptom: 'send',
        message: 'this session mqtt',
        evidence: [{ source: 'trace', summary: 'outbox_sender.mqtt_publish.failed' }],
      }),
      finding({
        code: 'model.catalog_ok',
        message: 'env is fine',
      }),
    ]
    const traces = [
      trace({ sessionId: 's1', stage: 'mqtt.publish', rawStage: 'outbox_sender.mqtt_publish.failed' }),
      trace({
        sessionId: 's2',
        traceId: 'm2',
        stage: 'mqtt.publish',
        rawStage: 'other.mqtt.failed',
      }),
    ]
    const scoped = findingsForSessionFocus(findings, traces, 's1')
    expect(scoped.map((item) => item.message)).toEqual(['this session mqtt', 'env is fine'])
  })

  it('builds a send stage strip that marks the failed hop', () => {
    const strip = sendStageStrip([
      trace({ stage: 'send.enqueue', rawStage: 'outbox.enqueue.ok', status: 'ok' }),
      trace({ stage: 'cloud.insert', rawStage: 'outbox_sender.message_insert.ok', status: 'ok' }),
      trace({
        stage: 'mqtt.publish',
        rawStage: 'outbox_sender.mqtt_publish.failed',
        status: 'error',
      }),
    ])
    expect(strip.map((s) => [s.id, s.status])).toEqual([
      ['enqueue', 'ok'],
      ['cloud', 'ok'],
      ['mqtt', 'error'],
      ['runtime', 'idle'],
      ['turn', 'idle'],
    ])
  })
})
