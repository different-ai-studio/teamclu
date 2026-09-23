import { CloudApiError } from '@/lib/backend/cloud-api/http'

/**
 * A "no" the outbox must not keep asking about.
 *
 * The retry loop exists for answers that can change — a dropped connection, a
 * 5xx, a rate limit. A refusal is not one of them: when the server says the
 * sender may not write to this session, the twentieth attempt gets the same
 * answer as the first, ten minutes later, and all the user sees in between is
 * the sending spinner.
 *
 * Only 403 counts among HTTP answers. A 401 is refreshed and retried inside the
 * HTTP client, and a 4xx that is really a client bug (400, 409) has its own
 * handling upstream.
 *
 * The daemon has one refusal of the same shape: a runtime cannot start in a
 * folder this machine does not have. That does not become true by waiting
 * either — see {@link WORKSPACE_UNAVAILABLE}.
 */
export interface SendRejection {
  /** i18n key for the reason, shown on the failed bubble and in a toast. */
  key: string
  fallback: string
}

const NOT_PARTICIPANT: SendRejection = {
  key: 'chat.sendStatus.rejectedNotParticipant',
  fallback: '你不在这个会话里，消息发不出去。请把自己加回会话成员，或让会话的创建者加你。',
}

const FORBIDDEN: SendRejection = {
  key: 'chat.sendStatus.rejectedForbidden',
  fallback: '服务器拒绝了这条消息：你没有权限在这个会话里发言。',
}

const WORKSPACE_UNAVAILABLE: SendRejection = {
  key: 'chat.sendStatus.rejectedWorkspaceUnavailable',
  fallback: '这个 agent 绑定的工作目录不在它那台机器上，所以起不来。请在它的设置里换一个本机存在的工作目录。',
}

/**
 * The daemon refuses `runtimeStart` when the session's workspace resolves to a
 * path it does not have — typically a folder belonging to whichever machine
 * created the session. Retrying cannot conjure the directory, so this joins the
 * 403s rather than spinning: observed on 2026-09-23 at attempt twelve, thirty
 * seconds apart, with nothing on screen but the sending state. See #1579.
 */
function workspaceUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return (
    message.includes('WORKSPACE_PATH_UNAVAILABLE') ||
    message.toLowerCase().includes('workspace path is not available on this machine')
  )
}

export function permanentSendRejection(error: unknown): SendRejection | null {
  if (workspaceUnavailable(error)) return WORKSPACE_UNAVAILABLE
  if (!(error instanceof CloudApiError) || error.status !== 403) return null
  // The one refusal with a repair the user can carry out, so it is worth
  // saying in their words instead of Postgres's.
  const message = error.message.toLowerCase()
  if (message.includes('row-level security') && message.includes('messages')) {
    return NOT_PARTICIPANT
  }
  return FORBIDDEN
}
