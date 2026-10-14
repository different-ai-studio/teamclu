/**
 * Enable the local Agent on demand (#1678).
 *
 * Features that only work with amuxd running — team file sync, a local app
 * session, creating an app from a local folder, initializing the team folder —
 * call {@link ensureLocalAgentEnabled} first. With the local Agent already on it
 * resolves at once; otherwise it opens the setup dialog (mounted once by
 * `LocalAgentEnableDialog`) and resolves when setup finishes (true) or the user
 * closes it (false), so the caller can simply carry on with what the user asked
 * for.
 *
 * This path never writes the member default: only the "no default anywhere"
 * enable at team entry does (see `daemon-onboarding.ts`).
 */
import { create } from 'zustand'
import i18n from '@/lib/i18n'
import { getBackend } from '@/lib/backend'
import { isTauri } from '@/lib/utils'
import { useDaemonOnboardingStore } from '@/stores/daemon-onboarding'

type Phase = 'closed' | 'intro' | 'running'

type ConfirmPrompt = {
  title: string
  message: string
  confirmLabel?: string
  resolve: (accepted: boolean) => void
}

type LocalAgentGateState = {
  /** `LocalAgentEnableDialog` is mounted. Before the app shell renders (the
   * team picker at sign-in) nothing could answer a question, so none is asked. */
  hostMounted: boolean
  phase: Phase
  /** A yes/no question about the local Agent (e.g. "it is the team default"). */
  confirm: ConfirmPrompt | null
}

export const useLocalAgentGateStore = create<LocalAgentGateState>(() => ({
  hostMounted: false,
  phase: 'closed',
  confirm: null,
}))

let waiters: Array<(ok: boolean) => void> = []

/**
 * Resolve when the local Agent is on and set up, opening the setup dialog if it
 * is off. `skipIntro` starts setup straight away — for a click whose whole
 * point was enabling (the sidebar card, the "no default agent" prompt).
 */
export async function ensureLocalAgentEnabled(opts?: { skipIntro?: boolean }): Promise<boolean> {
  if (!isTauri()) return true
  const store = useDaemonOnboardingStore.getState()
  const enabled = store.enabled ?? (await store.loadEnabled())
  if (enabled) return true
  return new Promise<boolean>((resolve) => {
    waiters.push(resolve)
    const { phase } = useLocalAgentGateStore.getState()
    if (phase === 'running') return
    if (opts?.skipIntro) {
      startLocalAgentEnable()
    } else if (phase === 'closed') {
      useLocalAgentGateStore.setState({ phase: 'intro' })
    }
  })
}

/** The user agreed (or never had to): run the enable inside the dialog. */
export function startLocalAgentEnable(): void {
  useLocalAgentGateStore.setState({ phase: 'running' })
  void useDaemonOnboardingStore.getState().enable()
}

/** Close the dialog and answer every caller waiting on it. */
export function settleLocalAgentEnable(ok: boolean): void {
  useLocalAgentGateStore.setState({ phase: 'closed' })
  const pending = waiters
  waiters = []
  for (const resolve of pending) resolve(ok)
}

/** Ask a yes/no question in-app. Resolves false when dismissed. */
export function confirmLocalAgentAction(prompt: Omit<ConfirmPrompt, 'resolve'>): Promise<boolean> {
  if (!isTauri() || !useLocalAgentGateStore.getState().hostMounted) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    // A second question while one is open answers the first with "no" rather
    // than leaving its caller hanging.
    useLocalAgentGateStore.getState().confirm?.resolve(false)
    useLocalAgentGateStore.setState({ confirm: { ...prompt, resolve } })
  })
}

export function settleLocalAgentConfirm(accepted: boolean): void {
  const current = useLocalAgentGateStore.getState().confirm
  useLocalAgentGateStore.setState({ confirm: null })
  current?.resolve(accepted)
}

/** This machine's agent id, from the daemon when it answers, else as last seen. */
export async function currentLocalAgentId(): Promise<string | null> {
  const { getLocalDaemonActorId } = await import('@/lib/daemon/daemon-agent-admin')
  const { getKnownLocalDaemonActorId } = await import('@/lib/daemon/local-daemon-identity')
  return (await getLocalDaemonActorId()) ?? getKnownLocalDaemonActorId()
}

/** Is this machine's agent the team-wide default of `teamId`? False when
 * either side cannot be read — the question is a courtesy, not a guard. */
export async function localAgentIsTeamDefault(teamId: string): Promise<boolean> {
  if (!isTauri()) return false
  const localId = await currentLocalAgentId()
  if (!localId) return false
  try {
    return (await getBackend().actors.getTeamDefaultAgent(teamId)) === localId
  } catch {
    return false
  }
}

/**
 * Before moving this machine's agent off `fromTeamId` (a team switch rebinds
 * it): when it is that team's default agent, say so and let the user back out.
 * Resolves true to go ahead.
 */
export async function confirmRebindAwayFromTeamDefault(fromTeamId: string): Promise<boolean> {
  if (useDaemonOnboardingStore.getState().enabled !== true) return true
  if (!(await localAgentIsTeamDefault(fromTeamId))) return true
  return confirmLocalAgentAction({
    title: i18n.t('localAgent.rebindTeamDefaultTitle', 'This agent is the team default'),
    message: i18n.t(
      'localAgent.rebindTeamDefaultMessage',
      "This computer's agent is the current team's default agent. Switching team moves it to the new team, and the current team's default will point to an agent that is offline. Its running tasks on this computer will be interrupted.",
    ),
    confirmLabel: i18n.t('localAgent.rebindTeamDefaultConfirm', 'Switch anyway'),
  })
}

/**
 * Switch the local Agent off after saying what that means (#1678): amuxd stops,
 * a member default pointing here is cleared, and with no other default the
 * next team entry enables it again. When it is the team default, the prompt
 * says so first. Resolves true when it was disabled.
 */
export async function disableLocalAgentWithConfirm(): Promise<boolean> {
  if (!isTauri()) return false
  const { useCurrentTeamStore } = await import('@/stores/current-team')
  const teamId = useCurrentTeamStore.getState().team?.id ?? null
  const isTeamDefault = teamId ? await localAgentIsTeamDefault(teamId) : false
  const consequences = i18n.t(
    'localAgent.disableMessage',
    "The local daemon stops and this computer's agent goes offline. If it is your default agent, that default is cleared. Files and settings stay on this computer. If this team then has no default agent, entering it will enable the local Agent again.",
  )
  const ok = await confirmLocalAgentAction({
    title: isTeamDefault
      ? i18n.t('localAgent.disableTeamDefaultTitle', 'Disable the team default agent?')
      : i18n.t('localAgent.disableTitle', 'Disable the local Agent?'),
    message: isTeamDefault
      ? `${i18n.t(
          'localAgent.disableTeamDefaultMessage',
          "This computer's agent is this team's default agent. An admin should confirm before it is disabled: everyone whose chats go to the team default will reach an offline agent until the default is changed.",
        )}\n\n${consequences}`
      : consequences,
    confirmLabel: i18n.t('localAgent.disableConfirm', 'Disable'),
  })
  if (!ok) return false
  await useDaemonOnboardingStore.getState().disable()
  return true
}

/** @internal test helper */
export function __resetLocalAgentGateForTest(): void {
  waiters = []
  useLocalAgentGateStore.setState({ hostMounted: false, phase: 'closed', confirm: null })
}
