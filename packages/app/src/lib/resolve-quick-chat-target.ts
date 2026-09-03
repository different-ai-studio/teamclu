import { getBackend } from '@/lib/backend'
import { getLocalDaemonAgent } from '@/lib/daemon-agent-admin'
import { isTauri } from '@/lib/utils'

type QuickChatSource = 'local' | 'member_default' | 'team_default'

export type QuickChatTarget = {
  agentId: string
  displayName: string
  source: QuickChatSource
}

export async function resolveQuickChatTarget(
  teamId: string,
  opts?: { workspacePath?: string | null },
): Promise<QuickChatTarget | null> {
  const trimmedTeam = teamId.trim()
  if (!trimmedTeam) return null

  // `opts.workspacePath` is accepted for API compatibility but intentionally no
  // longer gates local-agent selection (see below).
  void opts

  // On desktop, a new chat ALWAYS defaults to THIS machine's local daemon
  // agent when one exists — never the team default. The local agent is the
  // user's own runtime here; a new chat should talk to it, not to whatever
  // agent the team happens to have set as its default. `workspacePath` is no
  // longer a precondition (it gated this off when no workspace was active,
  // which wrongly fell through to the team default). Only when there is no
  // local daemon agent at all do we fall back to the team/member default.
  if (isTauri()) {
    try {
      const local = await getLocalDaemonAgent(trimmedTeam)
      if (local?.id) {
        return {
          agentId: local.id,
          displayName: local.displayName || local.id,
          source: 'local',
        }
      }
    } catch {
      // Fall through to effective default.
    }
  }

  const backend = getBackend()

  let effectiveId: string
  try {
    effectiveId = (await backend.actors.getEffectiveDefaultAgent(trimmedTeam))?.trim() || ''
  } catch {
    return null
  }
  if (!effectiveId) return null

  let memberId: string
  try {
    memberId = (await backend.actors.getMemberDefaultAgent(trimmedTeam))?.trim() || ''
  } catch {
    memberId = ''
  }

  const source: QuickChatSource =
    memberId && memberId === effectiveId ? 'member_default' : 'team_default'

  let displayName = effectiveId
  try {
    const actor = await backend.actors.getActorDirectoryEntry(effectiveId)
    const name = actor?.display_name?.trim()
    if (name) displayName = name
  } catch {
    // keep id fallback
  }

  return { agentId: effectiveId, displayName, source }
}
