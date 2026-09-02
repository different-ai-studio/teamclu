import * as React from 'react'
import { resolveQuickChatTarget, type QuickChatTarget } from '@/lib/resolve-quick-chat-target'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useMemberPreferencesStore } from '@/stores/member-preferences-store'
import { useMqttReconnectStore } from '@/stores/mqtt-reconnect'
import { useWorkspaceStore } from '@/stores/workspace'

/** Retry while stuck in no_agent (e.g. API recovered without MQTT/network signal). */
export const QUICK_CHAT_STUCK_RETRY_MS = 30_000

export type QuickChatState =
  | { kind: 'loading' }
  | { kind: 'no_team' }
  | { kind: 'no_agent' }
  | { kind: 'ready'; target: QuickChatTarget }

type QuickChatWelcomeAgent = {
  id: string
  displayName: string
}

/** Map quick-chat readiness to welcome-page agent + loading (NavRail uses the same source). */
export function quickChatWelcomeAgent(state: QuickChatState): {
  agent: QuickChatWelcomeAgent | null
  loading: boolean
} {
  if (state.kind === 'loading') return { agent: null, loading: true }
  if (state.kind === 'ready') {
    return {
      agent: {
        id: state.target.agentId,
        displayName: state.target.displayName,
      },
      loading: false,
    }
  }
  return { agent: null, loading: false }
}

/** Strict local daemon only — for "switch to local agent" in session banners. */
export function quickChatLocalDaemonAgent(state: QuickChatState): QuickChatWelcomeAgent | null {
  if (state.kind !== 'ready' || state.target.source !== 'local') return null
  return { id: state.target.agentId, displayName: state.target.displayName }
}

export function useQuickChatReadiness(): QuickChatState {
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const defaultAgentId = useMemberPreferencesStore((s) => s.defaultAgentId)
  const effectiveDefaultAgentId = useMemberPreferencesStore((s) => s.effectiveDefaultAgentId)
  const effectiveDefaultTeamId = useMemberPreferencesStore((s) => s.effectiveDefaultTeamId)
  const loadEffectiveDefaultAgent = useMemberPreferencesStore((s) => s.loadEffectiveDefaultAgent)
  const mqttConnected = useMqttReconnectStore((s) => s.connected)
  const mqttReconnectNonce = useMqttReconnectStore((s) => s.nonce)

  const [target, setTarget] = React.useState<QuickChatTarget | null>(null)
  const [resolving, setResolving] = React.useState(() => Boolean(teamId))
  const [recoveryPass, setRecoveryPass] = React.useState(0)
  const targetRef = React.useRef(target)
  const resolvingRef = React.useRef(resolving)
  const prevMqttConnectedRef = React.useRef<boolean | null>(null)
  const prevMqttNonceRef = React.useRef(mqttReconnectNonce)
  const resolveSettledRef = React.useRef(false)

  targetRef.current = target
  resolvingRef.current = resolving

  const requestRecovery = React.useCallback(() => {
    if (targetRef.current) return
    setRecoveryPass((pass) => pass + 1)
  }, [])

  const runRecovery = React.useCallback(
    (activeTeamId: string) => {
      if (targetRef.current) return
      void loadEffectiveDefaultAgent(activeTeamId)
      requestRecovery()
    },
    [loadEffectiveDefaultAgent, requestRecovery],
  )

  React.useEffect(() => {
    prevMqttConnectedRef.current = null
    prevMqttNonceRef.current = mqttReconnectNonce
    resolveSettledRef.current = false
    // Team switch must not keep the previous team's agent on screen.
    setTarget(null)
    setResolving(Boolean(teamId))
  }, [teamId])

  React.useEffect(() => {
    if (!teamId) {
      setTarget(null)
      setResolving(false)
      return
    }

    void loadEffectiveDefaultAgent(teamId)
  }, [teamId, loadEffectiveDefaultAgent])

  // MQTT connected after disconnect or first successful probe while still stuck.
  React.useEffect(() => {
    const prev = prevMqttConnectedRef.current
    prevMqttConnectedRef.current = mqttConnected
    if (!teamId || mqttConnected !== true) return
    if (targetRef.current) return
    if (prev === false || (prev === null && resolveSettledRef.current)) {
      runRecovery(teamId)
    }
  }, [mqttConnected, teamId, runRecovery])

  // Desktop/browser MQTT credential refresh or manual reconnect bump.
  React.useEffect(() => {
    const prev = prevMqttNonceRef.current
    prevMqttNonceRef.current = mqttReconnectNonce
    if (!teamId || prev === mqttReconnectNonce) return
    if (targetRef.current) return
    runRecovery(teamId)
  }, [mqttReconnectNonce, teamId, runRecovery])

  React.useEffect(() => {
    if (!teamId || typeof window === 'undefined') return
    const onOnline = () => runRecovery(teamId)
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [teamId, runRecovery])

  React.useEffect(() => {
    if (!teamId || typeof document === 'undefined') return
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      runRecovery(teamId)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [teamId, runRecovery])

  // Safety net when API recovers without MQTT/network/visibility signals.
  React.useEffect(() => {
    if (!teamId || typeof window === 'undefined') return
    const id = window.setInterval(() => {
      if (targetRef.current || resolvingRef.current) return
      runRecovery(teamId)
    }, QUICK_CHAT_STUCK_RETRY_MS)
    return () => window.clearInterval(id)
  }, [teamId, runRecovery])

  React.useEffect(() => {
    if (!teamId) {
      setTarget(null)
      setResolving(false)
      return
    }

    let cancelled = false
    const hadTarget = Boolean(targetRef.current)
    // Keep the last ready agent visible during silent re-resolves (MQTT /
    // prefs refresh). Only show the full-page spinner when we have nothing
    // to paint yet — otherwise the extension welcome flash: ready → spinner → ready.
    if (!hadTarget) {
      setResolving(true)
    }
    resolveSettledRef.current = false

    void resolveQuickChatTarget(teamId, { workspacePath })
      .then((resolved) => {
        if (!cancelled) {
          setTarget(resolved)
          setResolving(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTarget(null)
          setResolving(false)
        }
      })
      .finally(() => {
        if (!cancelled) resolveSettledRef.current = true
      })

    return () => {
      cancelled = true
    }
  }, [
    teamId,
    workspacePath,
    defaultAgentId,
    effectiveDefaultAgentId,
    effectiveDefaultTeamId,
    recoveryPass,
  ])

  return React.useMemo((): QuickChatState => {
    if (!teamId) return { kind: 'no_team' }
    if (resolving) return { kind: 'loading' }
    if (!target) return { kind: 'no_agent' }
    return { kind: 'ready', target }
  }, [teamId, resolving, target])
}
