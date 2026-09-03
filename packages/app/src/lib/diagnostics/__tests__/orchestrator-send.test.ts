import { describe, expect, it } from 'vitest'
import { diagnose } from '../orchestrator'
import { emptyCtx, trace } from './orchestrator-helpers'

describe('diagnose send flow', () => {
  it('emits no send finding when the user has not sent anything', () => {
    const findings = diagnose(emptyCtx())
    expect(findings.filter((f) => f.symptom === 'send' || f.symptom === 'agent')).toEqual([])
  })

  it('reports outbox failed with lastError evidence', () => {
    const findings = diagnose(
      emptyCtx({
        outbox: [
          {
            messageId: 'm1',
            sessionId: 's1',
            state: 'failed',
            lastError: 'Cloud insert 500',
            attemptCount: 3,
            updatedAt: '2026-09-03T00:01:00.000Z',
          },
        ],
      }),
    )
    const failed = findings.find((f) => f.code === 'send.outbox_failed')
    expect(failed?.status).toBe('fail')
    expect(failed?.evidence.some((e) => String(e.data?.lastError).includes('Cloud insert'))).toBe(
      true,
    )
  })

  it('treats remote MQTT publish failure as fail and local_fast as warn', () => {
    const remote = diagnose(
      emptyCtx({
        traces: [
          trace({
            stage: 'mqtt.publish',
            rawStage: 'outbox_sender.mqtt_publish.failed',
            status: 'error',
            path: 'remote',
            errorCode: 'broker down',
          }),
        ],
      }),
    )
    expect(remote.find((f) => f.code === 'send.mqtt_publish_failed')?.status).toBe('fail')

    const local = diagnose(
      emptyCtx({
        traces: [
          trace({
            stage: 'mqtt.publish',
            rawStage: 'outbox_sender.mqtt_publish.failed',
            status: 'error',
            path: 'local_fast',
            errorCode: 'broker down',
          }),
        ],
      }),
    )
    expect(local.find((f) => f.code === 'send.mqtt_publish_failed')?.status).toBe('warn')
  })

  it('warns delivered_no_turn when delivery succeeded and runtime is active', () => {
    const findings = diagnose(
      emptyCtx({
        outbox: [
          {
            messageId: 'm1',
            sessionId: 's1',
            state: 'delivered',
            lastError: null,
            attemptCount: 1,
            updatedAt: '2026-09-03T00:01:00.000Z',
          },
        ],
        traces: [trace({ stage: 'outbox.attempt', status: 'ok' })],
        runtimeActivity: { active: true, lastTurnError: null },
      }),
    )
    expect(findings.find((f) => f.code === 'send.delivered_no_turn')?.status).toBe('warn')
    expect(findings.some((f) => f.code === 'send.path_ok')).toBe(false)
  })
})
