import { afterEach, describe, expect, it } from 'vitest'
import { adaptSessionFlowLog } from '../session-flow-adapter'
import { clearTraceBuffer, listTraces } from '../trace-buffer'

describe('session-flow-adapter', () => {
  afterEach(() => {
    clearTraceBuffer()
  })

  it('does not record logs that lack messageId and sessionId', () => {
    adaptSessionFlowLog('outbox_sender.tick', { pending: 2 }, 'info')
    expect(listTraces()).toEqual([])
  })

  it('maps .ok / .failed / .begin suffixes onto status and stage', () => {
    adaptSessionFlowLog(
      'outbox_sender.mqtt_publish.begin',
      { messageId: 'm1', sessionId: 's1' },
      'info',
    )
    adaptSessionFlowLog(
      'outbox_sender.mqtt_publish.ok',
      { messageId: 'm1', sessionId: 's1' },
      'info',
    )
    adaptSessionFlowLog(
      'outbox_sender.message_insert.failed',
      { messageId: 'm1', sessionId: 's1', error: { name: 'Error', message: 'boom' } },
      'error',
    )

    const events = listTraces({ traceId: 'm1' })
    expect(events).toHaveLength(3)
    expect(events[0]).toMatchObject({
      stage: 'mqtt.publish',
      rawStage: 'outbox_sender.mqtt_publish.begin',
      status: 'ok',
    })
    expect(events[1]).toMatchObject({
      stage: 'mqtt.publish',
      rawStage: 'outbox_sender.mqtt_publish.ok',
      status: 'ok',
    })
    expect(events[2]).toMatchObject({
      stage: 'cloud.insert',
      rawStage: 'outbox_sender.message_insert.failed',
      status: 'error',
      errorCode: 'boom',
    })
  })

  it('pairs .begin with a later terminal event to set durationMs', () => {
    const beginAt = Date.now()
    adaptSessionFlowLog(
      'outbox_sender.attempt.begin',
      { messageId: 'm2', sessionId: 's1', attemptCount: 2 },
      'info',
    )
    adaptSessionFlowLog(
      'outbox_sender.attempt.delivered',
      { messageId: 'm2', sessionId: 's1', path: 'local_fast' },
      'info',
    )

    const [begin, done] = listTraces({ traceId: 'm2' })
    expect(begin?.durationMs).toBeUndefined()
    expect(done?.status).toBe('ok')
    expect(done?.path).toBe('local_fast')
    expect(done?.attempt).toBe(2)
    expect(done?.durationMs).toBeGreaterThanOrEqual(0)
    expect(Date.parse(done!.startedAt)).toBeGreaterThanOrEqual(beginAt)
  })

  it('uses session:${sessionId} as traceId when messageId is missing', () => {
    adaptSessionFlowLog('ensure_agent_runtime.workspace_resolved', { sessionId: 's9' }, 'info')
    const [event] = listTraces()
    expect(event?.traceId).toBe('session:s9')
    expect(event?.stage).toBe('runtime.ensure')
  })
})
