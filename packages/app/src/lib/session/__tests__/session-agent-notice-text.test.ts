import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import { buildPostSendSessionNotice } from '@/lib/session/session-agent-notice-text'

const t = ((key: string) => key) as TFunction

describe('buildPostSendSessionNotice', () => {
  it('uses runtime failure copy instead of offline copy', () => {
    const notice = buildPostSendSessionNotice([
      {
        agent: { id: 'agent-1', displayName: 'Build Bot' },
        uiState: 'runtime-error',
      },
    ], t)

    expect(notice).toBe('chat.sessionNotice.sentRuntimeErrorOne')
    expect(notice).not.toBe('chat.sessionNotice.sentOfflineOne')
  })
})
