import { describe, expect, it } from 'vitest'
import { permanentSendRejection } from '@/lib/messages/send-rejection'
import { CloudApiError } from '@/lib/backend/cloud-api/http'

describe('permanentSendRejection', () => {
  it('names the real reason when RLS refuses the message insert', () => {
    // What a session whose roster lost the sender actually answers. Retrying it
    // 20 times over ten minutes is what left the user watching a spinner.
    const rejection = permanentSendRejection(
      new CloudApiError(
        403,
        'forbidden',
        'new row violates row-level security policy for table "messages"',
        null,
      ),
    )
    expect(rejection).toEqual({
      key: 'chat.sendStatus.rejectedNotParticipant',
      fallback: '你不在这个会话里，消息发不出去。请把自己加回会话成员，或让会话的创建者加你。',
    })
  })

  it('still stops on a refusal it cannot explain', () => {
    expect(permanentSendRejection(new CloudApiError(403, 'forbidden', 'nope', null))).toEqual({
      key: 'chat.sendStatus.rejectedForbidden',
      fallback: '服务器拒绝了这条消息：你没有权限在这个会话里发言。',
    })
  })

  it('stops retrying when the agent has no such folder', () => {
    // The daemon's refusal, not the server's: a directory that is not on that
    // machine does not appear because we asked twelve more times.
    expect(
      permanentSendRejection(
        new Error('workspace path is not available on this machine: /Users/someone/TeamClu'),
      )?.key,
    ).toBe('chat.sendStatus.rejectedWorkspaceUnavailable')
    expect(permanentSendRejection(new Error('runtimeStart failed: WORKSPACE_PATH_UNAVAILABLE'))?.key).toBe(
      'chat.sendStatus.rejectedWorkspaceUnavailable',
    )
  })

  it('keeps retrying everything that might succeed later', () => {
    // 5xx, rate limits and a dropped connection are exactly what the backoff is
    // for; 401 is refreshed and retried a layer below.
    expect(permanentSendRejection(new CloudApiError(500, 'internal', 'boom', null))).toBeNull()
    expect(permanentSendRejection(new CloudApiError(429, 'rate_limited', 'slow down', null))).toBeNull()
    expect(permanentSendRejection(new CloudApiError(401, 'missing_auth', 'expired', null))).toBeNull()
    expect(permanentSendRejection(new Error('network error'))).toBeNull()
    expect(permanentSendRejection(undefined)).toBeNull()
  })
})
