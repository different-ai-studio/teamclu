import type { TraceEvent } from './types'

export const TRACE_BUFFER_MAX = 800

const buffer: TraceEvent[] = []

export function recordTrace(event: TraceEvent): void {
  buffer.push(event)
  if (buffer.length > TRACE_BUFFER_MAX) {
    buffer.splice(0, buffer.length - TRACE_BUFFER_MAX)
  }
}

export function listTraces(filter?: { sessionId?: string; traceId?: string }): TraceEvent[] {
  return buffer.filter((event) => {
    if (filter?.sessionId && event.sessionId !== filter.sessionId) return false
    if (filter?.traceId && event.traceId !== filter.traceId) return false
    return true
  })
}

export function clearTraceBuffer(): void {
  buffer.splice(0, buffer.length)
}
