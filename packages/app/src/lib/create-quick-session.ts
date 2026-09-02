import { resolveQuickChatTarget, type QuickChatTarget } from '@/lib/resolve-quick-chat-target'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useUIStore } from '@/stores/ui'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * Why a quick draft could not be opened. Callers branch on this to show the
 * RIGHT message instead of a blanket "agent offline" toast:
 * - `no_team`      — no team selected/joined yet.
 * - `no_agent`     — no target agent resolvable (no local daemon agent, and
 *                    both the member default and team default are unset). This
 *                    is NOT a connectivity problem — guide the user to set a
 *                    default agent.
 * - `no_actor`     — retained for toast mapping compatibility; draft-first
 *                    no longer hits this path.
 * - `server_error` — target resolution threw (backend/transport error).
 */
export type QuickSessionFailureReason = 'no_team' | 'no_agent' | 'no_actor' | 'server_error'

type QuickSessionOutcome =
  | { ok: true; agentDisplayName: string }
  | { ok: false; reason: QuickSessionFailureReason; error?: unknown }

/**
 * Open a local draft chat with the resolved default agent. Does NOT create a
 * backend session — that happens when the user sends the first message.
 */
export async function createQuickSession(
  targetOverride?: QuickChatTarget | null,
): Promise<QuickSessionOutcome> {
  const teamId = useCurrentTeamStore.getState().team?.id ?? null
  if (!teamId) return { ok: false, reason: 'no_team' }

  let target: QuickChatTarget | null
  try {
    target =
      targetOverride ??
      (await resolveQuickChatTarget(teamId, {
        workspacePath: useWorkspaceStore.getState().workspacePath,
      }))
  } catch (error) {
    return { ok: false, reason: 'server_error', error }
  }
  if (!target) return { ok: false, reason: 'no_agent' }

  useUIStore.getState().enterActorDraft({
    id: target.agentId,
    displayName: target.displayName,
    kind: 'agent',
  })
  useUIStore.getState().requestComposerFocus()

  return { ok: true, agentDisplayName: target.displayName }
}

/**
 * Map a failure reason to a user-facing toast. `no_agent` is guidance (set a
 * default agent), not an error; `no_actor`/`server_error` are genuine failures;
 * none of them claim the agent is "offline" unless that's actually true.
 */
export function describeQuickSessionFailure(
  reason: QuickSessionFailureReason,
  t: (key: string, fallback: string) => string,
): { title: string; description: string } {
  switch (reason) {
    case 'no_agent':
      return {
        title: t('chat.quickSessionNoAgentTitle', '尚未设置默认 Agent'),
        description: t(
          'chat.quickSessionNoAgentHint',
          '请设置个人默认 Agent，或联系管理员设置团队默认 Agent。',
        ),
      }
    case 'no_team':
      return {
        title: t('chat.quickSessionCreateError', '无法开始新对话'),
        description: t('chat.quickSessionNoTeamHint', '请先选择或加入一个团队后再试。'),
      }
    case 'no_actor':
    case 'server_error':
    default:
      return {
        title: t('chat.quickSessionServerError', '无法开始新对话'),
        description: t(
          'chat.quickSessionServerErrorDesc',
          '暂时无法准备新对话，请稍后重试。',
        ),
      }
  }
}
