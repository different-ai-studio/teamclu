import { describe, it, expect, vi, beforeEach } from 'vitest'

const telemetryMock = vi.hoisted(() => ({
  insertFeedback: vi.fn(),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({ telemetry: telemetryMock }),
}))

import { insertFeedback } from '@/lib/telemetry/feedback'

describe('insertFeedback', () => {
  beforeEach(() => {
    telemetryMock.insertFeedback.mockReset()
    telemetryMock.insertFeedback.mockResolvedValue(undefined)
  })

  it('forwards camelCase feedback to the Cloud API with kind=positive', async () => {
    await insertFeedback({
      actorId: 'a-1', teamId: 't-1', sessionId: 's-1',
      messageId: 'm-1', kind: 'positive', skill: 'editor',
    })
    // Cloud API contract is camelCase (FC validates body.messageId/actorId/...).
    expect(telemetryMock.insertFeedback).toHaveBeenCalledWith({
      messageId: 'm-1', actorId: 'a-1', teamId: 't-1', sessionId: 's-1',
      kind: 'positive', starRating: null, skill: 'editor',
    })
  })
})
