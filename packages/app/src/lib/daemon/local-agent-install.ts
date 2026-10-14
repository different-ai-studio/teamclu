import { invoke } from '@tauri-apps/api/core'

import { getBackend } from '@/lib/backend'
import { isTauri } from '@/lib/utils'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useDaemonOnboardingStore } from '@/stores/daemon-onboarding'
import {
  markLocalAgentInstallPending,
  publishLocalAgentInstall,
  useLocalAgentInstallStore,
  type LocalAgentInstallRecord,
} from '@/stores/local-agent-install'

const installInflight = new Map<string, Promise<LocalAgentInstallRecord>>()
const skipInflight = new Map<string, Promise<boolean>>()

const UNKNOWN: LocalAgentInstallRecord = {
  status: 'unknown',
  agentId: null,
  displayName: null,
}

/**
 * Classify this team on this machine for the signed-in account.
 *
 * `installed` — for-device returned an agent. Later failures stay on that
 * agent; they do not fall through to a member or team default.
 * `absent` — the device id resolved and for-device came back empty.
 * `unknown` — the id could not be resolved, or the lookup failed. Do not
 * skip the install gate.
 *
 * One in-flight promise per team so AuthGate and switchToTeam share it
 * before either calls daemon refresh.
 */
export function resolveLocalAgentInstall(teamId: string): Promise<LocalAgentInstallRecord> {
  const id = teamId.trim()
  if (!id) return Promise.resolve(UNKNOWN)
  const existing = installInflight.get(id)
  if (existing) return existing
  markLocalAgentInstallPending(id)
  const promise = classify(id)
    .then((record) => {
      publishLocalAgentInstall(id, record)
      return record
    })
    .catch(() => {
      publishLocalAgentInstall(id, UNKNOWN)
      return UNKNOWN
    })
  installInflight.set(id, promise)
  return promise
}

export function invalidateLocalAgentInstall(teamId: string): void {
  const id = teamId.trim()
  if (!id) return
  installInflight.delete(id)
  skipInflight.delete(id)
}

/**
 * After the install wizard finishes, pull the actor directory again and then
 * reclassify. The sidebar card already looks that list up; a new list makes
 * it re-query the daemon and draw the real row.
 */
export async function refreshAfterLocalAgentInstall(teamId: string): Promise<void> {
  const id = teamId.trim()
  if (!id) return
  invalidateLocalAgentInstall(id)
  const { useActorDirectoryStore } = await import('@/stores/actor-directory-store')
  await useActorDirectoryStore.getState().refetch(id)
  await resolveLocalAgentInstall(id)
}

/** Test-only. Production callers use invalidateLocalAgentInstall. */
export function resetLocalAgentInstallForTests(): void {
  installInflight.clear()
  skipInflight.clear()
}

async function classify(teamId: string): Promise<LocalAgentInstallRecord> {
  if (!isTauri()) return UNKNOWN
  const deviceId = await readStableDeviceId()
  if (!deviceId) return UNKNOWN
  try {
    const found = await getBackend().actors.findAgentForDevice({ teamId, deviceId })
    const agentId = found?.agentId?.trim() || ''
    if (!agentId) return { status: 'absent', agentId: null, displayName: null }
    return {
      status: 'installed',
      agentId,
      displayName: found.displayName?.trim() || null,
    }
  } catch {
    return UNKNOWN
  }
}

async function readStableDeviceId(): Promise<string | null> {
  try {
    const id = await invoke<string | null>('read_stable_device_id')
    const trimmed = id?.trim() ?? ''
    return trimmed || null
  } catch {
    return null
  }
}

/**
 * Skip the install gate only when this machine has no local agent for the
 * account AND the team has a default agent. Anything else keeps today's
 * refresh.
 */
export function shouldSkipLocalAgentInstall(teamId: string): Promise<boolean> {
  const id = teamId.trim()
  if (!id) return Promise.resolve(false)
  const existing = skipInflight.get(id)
  if (existing) return existing
  const promise = (async () => {
    const install = await resolveLocalAgentInstall(id)
    if (install.status !== 'absent') return false
    try {
      const agentId = await getBackend().actors.getTeamDefaultAgent(id)
      return Boolean(agentId?.trim())
    } catch {
      return false
    }
  })()
  skipInflight.set(id, promise)
  return promise
}

/**
 * Shared gate in front of daemon refresh. Callers that would have called
 * `useDaemonOnboardingStore.refresh` on team entry go through here so the
 * first one cannot start the daemon before classification finishes.
 */
export async function refreshDaemonUnlessSkipped(opts?: {
  forceIdentityRebind?: boolean
}): Promise<void> {
  const teamId = useCurrentTeamStore.getState().team?.id?.trim() || ''
  if (teamId && (await shouldSkipLocalAgentInstall(teamId))) {
    useLocalAgentInstallStore.setState({ gateSkippedTeamId: teamId })
    useDaemonOnboardingStore.setState({
      loaded: true,
      status: 'unknown',
      busy: false,
      error: null,
      pendingName: null,
    })
    return
  }
  useLocalAgentInstallStore.setState({ gateSkippedTeamId: null })
  await useDaemonOnboardingStore.getState().refresh(opts)
}
