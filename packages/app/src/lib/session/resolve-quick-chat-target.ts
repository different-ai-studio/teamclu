import { getBackend } from '@/lib/backend'
import { getLocalDaemonAgent } from '@/lib/daemon/daemon-agent-admin'
import { resolveLocalAgentInstall } from '@/lib/daemon/local-agent-install'
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
    let local: { id: string; displayName: string } | null
    try {
      local = await getLocalDaemonAgent(trimmedTeam)
    } catch {
      local = null
    }
    if (local?.id) {
      return {
        agentId: local.id,
        displayName: local.displayName || local.id,
        source: 'local',
      }
    }
    // Installed but the daemon HTTP is down: stay on this machine's agent.
    // Absent and unknown keep the member → team cascade below.
    try {
      const install = await resolveLocalAgentInstall(trimmedTeam)
      if (install.status === 'installed' && install.agentId) {
        return {
          agentId: install.agentId,
          displayName: install.displayName || install.agentId,
          source: 'local',
        }
      }
    } catch {
      // Unknown install state keeps the cascade.
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
