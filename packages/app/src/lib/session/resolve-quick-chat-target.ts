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

/**
 * The local Agent is enabled but could not be identified in time — the daemon
 * is down and this client has no record of which agent it runs as in this
 * team. Deliberately not a silent fallback to a remote default (#1678): the
 * user is told to pick an agent by hand.
 */
export class LocalAgentUnavailableError extends Error {
  constructor() {
    super('local agent unavailable')
    this.name = 'LocalAgentUnavailableError'
  }
}

/** How long a new chat waits for the local daemon to answer before giving up. */
export const LOCAL_AGENT_WAIT_MS = 20_000
const LOCAL_AGENT_POLL_MS = 1_000

async function localAgentEnabled(): Promise<boolean> {
  const { useDaemonOnboardingStore } = await import('@/stores/daemon-onboarding')
  const store = useDaemonOnboardingStore.getState()
  return store.enabled ?? (await store.loadEnabled())
}

async function liveLocalAgent(teamId: string): Promise<QuickChatTarget | null> {
  try {
    const local = await getLocalDaemonAgent(teamId)
    if (!local?.id) return null
    return { agentId: local.id, displayName: local.displayName || local.id, source: 'local' }
  } catch {
    return null
  }
}

/**
 * This machine's agent in `teamId` as last seen, for when the daemon is not
 * answering. Only trusted when the daemon was last bound to this very team —
 * the remembered id is per machine, and amuxd takes a different actor in each.
 */
async function rememberedLocalAgent(teamId: string): Promise<QuickChatTarget | null> {
  const { readDaemonOnboardingIdentity } = await import('@/lib/daemon/daemon-onboarding-identity')
  const { getKnownLocalDaemonActorId } = await import('@/lib/daemon/local-daemon-identity')
  if (readDaemonOnboardingIdentity()?.teamId !== teamId) return null
  const agentId = getKnownLocalDaemonActorId()
  if (!agentId) return null
  let displayName = agentId
  try {
    const name = (await getBackend().actors.getActorDirectoryEntry(agentId))?.display_name?.trim()
    if (name) displayName = name
  } catch {
    // keep id fallback
  }
  return { agentId, displayName, source: 'local' }
}

/**
 * Resolve this machine's agent for a new chat. A live daemon answers first;
 * failing that the remembered agent is used, so the chat opens straight away
 * and its messages wait for the daemon to come back. With neither, wait for
 * the daemon up to `waitMs`.
 */
async function resolveLocalAgentTarget(
  teamId: string,
  waitMs: number,
): Promise<QuickChatTarget | null> {
  const live = await liveLocalAgent(teamId)
  if (live) return live
  const remembered = await rememberedLocalAgent(teamId)
  if (remembered) return remembered
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, LOCAL_AGENT_POLL_MS))
    const again = await liveLocalAgent(teamId)
    if (again) return again
  }
  return null
}

/**
 * Who a new chat talks to: this machine's agent when the local Agent is
 * enabled → the member default → the team default (#1678).
 *
 * Enabled means the local agent, full stop — even over a member default naming
 * another agent, and even while the daemon is briefly down (then
 * {@link LocalAgentUnavailableError} after `waitMs`, never a quiet switch to a
 * remote agent). Choosing a remote agent by hand is always possible from the
 * advanced new-session dialog, which does not come through here.
 */
export async function resolveQuickChatTarget(
  teamId: string,
  opts?: { workspacePath?: string | null; waitMs?: number },
): Promise<QuickChatTarget | null> {
  const trimmedTeam = teamId.trim()
  if (!trimmedTeam) return null

  if (isTauri() && (await localAgentEnabled())) {
    // Never installed: talk to the member or team default. Enabled-but-down
    // still waits and then asks the user to pick, instead of switching quietly.
    let installStatus: string | null = null
    try {
      installStatus = (await resolveLocalAgentInstall(trimmedTeam)).status
    } catch {
      installStatus = null
    }
    if (installStatus !== 'absent') {
      const local = await resolveLocalAgentTarget(trimmedTeam, opts?.waitMs ?? LOCAL_AGENT_WAIT_MS)
      if (local) return local
      throw new LocalAgentUnavailableError()
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
