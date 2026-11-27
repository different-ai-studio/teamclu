import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))

import { buildBeat } from '../ui-heartbeat'

describe('buildBeat', () => {
  it('reports the latest long task inside the last minute', () => {
    const now = 1_000_000
    const beat = buildBeat(now, true, 'chat/skills/task', [
      { durationMs: 900, at: now - 70_000 }, // outside the window
      { durationMs: 120.4, at: now - 30_000 },
      { durationMs: 2400.6, at: now - 1_500 },
    ])
    expect(beat).toEqual({
      visible: true,
      route: 'chat/skills/task',
      lastLongTask: { durationMs: 2401, agoMs: 1500 },
      longTasksLastMinute: 2,
    })
  })

  it('sends null when there were no long tasks', () => {
    expect(buildBeat(5, false, 'chat/session/task', []).lastLongTask).toBeNull()
  })
})
