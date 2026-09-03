import { afterEach, describe, expect, it } from 'vitest'
import { TRACE_BUFFER_MAX, clearTraceBuffer, listTraces, recordTrace } from '../trace-buffer'
import type { TraceEvent } from '../types'

function event(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    traceId: 'msg-1',
    sessionId: 'sess-1',
    stage: 'outbox.attempt',
    rawStage: 'outbox_sender.attempt.begin',
    status: 'ok',
    startedAt: '2026-09-03T00:00:00.000Z',
    ...overrides,
  }
}

describe('trace-buffer', () => {
  afterEach(() => {
    clearTraceBuffer()
  })

  it('drops the oldest events once the ring exceeds 800', () => {
    for (let i = 0; i < TRACE_BUFFER_MAX + 5; i += 1) {
      recordTrace(event({ traceId: `msg-${i}`, startedAt: `2026-09-03T00:00:${String(i % 60).padStart(2, '0')}.000Z` }))
    }

    const all = listTraces()
    expect(all).toHaveLength(TRACE_BUFFER_MAX)
    expect(all[0]?.traceId).toBe('msg-5')
    expect(all[all.length - 1]?.traceId).toBe(`msg-${TRACE_BUFFER_MAX + 4}`)
  })

  it('filters by sessionId and traceId', () => {
    recordTrace(event({ traceId: 'a', sessionId: 's1' }))
    recordTrace(event({ traceId: 'b', sessionId: 's1' }))
    recordTrace(event({ traceId: 'c', sessionId: 's2' }))

    expect(listTraces({ sessionId: 's1' }).map((e) => e.traceId)).toEqual(['a', 'b'])
    expect(listTraces({ traceId: 'c' }).map((e) => e.traceId)).toEqual(['c'])
  })
})
