import { getSession } from '@/lib/auth/session-store'
import { buildConfig } from '@/lib/build-config'
import { probeDaemonHttp } from '@/lib/daemon-local-client'
import { describeJwt } from '@/lib/diag-redact'
import { getDaemonLiveConnected } from '@/lib/live-dedup-stats'
import { getMqttDiagSnapshot } from '@/lib/mqtt-diagnostics'
import { mqttStatus } from '@/lib/mqtt-bridge'
import { getStartupTimeline } from '@/lib/startup-perf'
import { isTauri } from '@/lib/utils'
import { fetchAppVersion } from '@/lib/version'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useMqttReconnectStore } from '@/stores/mqtt-reconnect'
import { useSessionStore } from '@/stores/session-store'

export interface RuntimeStateSnapshot {
  generatedAt: string
  environment: {
    version: string
    buildFlavor: string
    platform: string
    tauri: boolean
    userAgent: string | null
    visibilityState: string
  }
  mqtt: {
    bridge: Awaited<ReturnType<typeof mqttStatus>> | null
    reconnect: {
      connected: boolean | null
      lastError: string | null
      nonce: number
    }
    recentEvents: unknown[]
    daemonLiveConnected: boolean
  }
  auth: {
    user: { id?: string; email?: string | null; is_anonymous?: boolean } | null | undefined
    accessToken: ReturnType<typeof describeJwt>
    refreshTokenPresent: boolean
    expiresAt: number | null | undefined
  } | null
  session: {
    activeSessionId: string | null
    currentSessionId: string | null
  }
  team: {
    id: string | null
    name: string | null
  }
  daemon: Awaited<ReturnType<typeof probeDaemonHttp>> | null
  startupTimeline: ReturnType<typeof getStartupTimeline>
}

export async function getRuntimeStateSnapshot(): Promise<RuntimeStateSnapshot> {
  const version = await fetchAppVersion().catch(() => 'unknown')
  const mqttBridge = await mqttStatus().catch(() => null)
  const mqttReconnect = useMqttReconnectStore.getState()
  const mqttDiag = getMqttDiagSnapshot()
  const session = getSession()
  const sessionStore = useSessionStore.getState()
  const teamState = useCurrentTeamStore.getState()
  const daemon = isTauri() ? await probeDaemonHttp().catch(() => null) : null

  return {
    generatedAt: new Date().toISOString(),
    environment: {
      version,
      buildFlavor: buildConfig.app.palette ?? 'default',
      platform: typeof navigator !== 'undefined' ? navigator.platform : 'unknown',
      tauri: isTauri(),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      visibilityState:
        typeof document !== 'undefined' ? document.visibilityState : 'unknown',
    },
    mqtt: {
      bridge: mqttBridge,
      reconnect: {
        connected: mqttReconnect.connected,
        lastError: mqttReconnect.lastError,
        nonce: mqttReconnect.nonce,
      },
      recentEvents: Array.isArray(mqttDiag.events) ? mqttDiag.events.slice(-20) : [],
      daemonLiveConnected: getDaemonLiveConnected(),
    },
    auth: session
      ? {
          user: session.user ?? null,
          accessToken: describeJwt(session.access_token),
          refreshTokenPresent: Boolean(session.refresh_token),
          expiresAt: session.expires_at,
        }
      : null,
    session: {
      activeSessionId: sessionStore.activeSessionId ?? null,
      currentSessionId: sessionStore.currentSessionId ?? null,
    },
    team: {
      id: teamState.team?.id ?? null,
      name: teamState.team?.name ?? null,
    },
    daemon,
    startupTimeline: getStartupTimeline(),
  }
}
