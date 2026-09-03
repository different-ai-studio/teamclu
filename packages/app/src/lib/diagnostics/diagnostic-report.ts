import { invoke } from '@tauri-apps/api/core'
import { getSession } from '@/lib/auth/session-store'
import { buildConfig, localAgent } from '@/lib/config/build-config'
import { getConsoleEntries } from '@/lib/diagnostics/console-capture'
import { resolveCurrentMemberActorId } from '@/lib/actor/current-actor'
import { probeDaemonHttp, type DaemonHttpProbe } from '@/lib/daemon/daemon-local-client'
import { getMqttDiagSnapshot } from '@/lib/mqtt/mqtt-diagnostics'
import { mqttStatus } from '@/lib/mqtt/mqtt-bridge'
import { getDaemonLiveConnected } from '@/lib/diagnostics/live-dedup-stats'
import { probeMqttBroker, type MqttProbeResult } from '@/lib/mqtt/mqtt-probe'
import {
  parseBrokerHost,
  probeCloudEndpointSeries,
  probeCloudHealthSeries,
  probeHttp,
  summarizeMqttNetworkEvents,
  type CloudProbeSeries,
  type HttpProbeResult,
  type MqttEventSummary,
} from '@/lib/diagnostics/network-diagnostic-probes'
import { getEffectiveServerConfigSync } from '@/lib/config/server-config'
import { getStartupTimeline, type StartupStamp } from '@/lib/telemetry/startup-perf'
import { getRuntimeStateSnapshot } from '@/lib/agent/runtime-state-snapshot'
import { isTauri } from '@/lib/utils'
import { fetchAppVersion } from '@/lib/config/version'
import { collectDiagnosticContext } from '@/lib/diagnostics/collect-context'
import { diagnose } from '@/lib/diagnostics/orchestrator'
import { causeCodesFromFindings } from '@/lib/diagnostics/remediations'
import type { DiagnosticCauseCode, DiagnosticFinding, TraceEvent } from '@/lib/diagnostics/types'
import type { RequirementStatus } from '@/stores/setup'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useMqttReconnectStore } from '@/stores/mqtt-reconnect'
import { useWorkspaceStore } from '@/stores/workspace'
import type { SettingsSection } from '@/stores/ui'

export type DiagnosticStatus = 'ok' | 'warn' | 'fail'

/** Qualifying reasons to offer `amuxd clear` from diagnostics. */
type DaemonResetTrigger =
  | 'daemon_http_token_invalid'
  | 'daemon_http_port_missing'
  | 'daemon_info_unreadable'
  | 'daemon_cloud_auth_expired'
  | 'daemon_team_mismatch'

export interface DiagnosticCheck {
  id: string
  title: string
  status: DiagnosticStatus
  message: string
  hint?: string
  hintSection?: SettingsSection
  resetTrigger?: DaemonResetTrigger
}

interface DaemonResetRemediationContext {
  /** When true, cloud-auth expiry qualifies for reset (auto-heal already failed). */
  cloudAuthHealFailed?: boolean
  teamMismatch?: boolean
}

interface DaemonResetRemediation {
  suggest: boolean
  triggers: DiagnosticCheck[]
}

const ALWAYS_RESET_TRIGGERS = new Set<DaemonResetTrigger>([
  'daemon_http_token_invalid',
  'daemon_http_port_missing',
  'daemon_info_unreadable',
  'daemon_team_mismatch',
])

export function collectDaemonResetRemediation(
  checks: DiagnosticCheck[],
  context: DaemonResetRemediationContext = {},
): DaemonResetRemediation {
  const triggers: DiagnosticCheck[] = []

  for (const check of checks) {
    if (!check.resetTrigger) continue
    if (ALWAYS_RESET_TRIGGERS.has(check.resetTrigger)) {
      triggers.push(check)
      continue
    }
    if (check.resetTrigger === 'daemon_cloud_auth_expired' && context.cloudAuthHealFailed) {
      triggers.push(check)
    }
  }

  if (context.teamMismatch) {
    triggers.push({
      id: 'daemon_team_mismatch',
      title: 'Daemon 团队绑定',
      status: 'fail',
      message: '本机 daemon 绑定的团队与当前登录团队不一致',
      resetTrigger: 'daemon_team_mismatch',
    })
  }

  return { suggest: triggers.length > 0, triggers }
}

export interface TeamEnvDiagnostics {
  teamIdPresent: boolean
  teamLinkPath: string
  linkExists: boolean
  linkIsSymlink: boolean
  linkTarget: string | null
  targetAccessible: boolean
  /** Daemon cloud cache `~/.amuxd/teams/<id>/cloud/_secrets`. */
  secretsDirExists: boolean
  secretFileCount: number
  cloudSecretsDir?: string
  legacySecretsDirExists?: boolean
  legacySecretFileCount?: number
  secretConfigured: boolean
}

interface DiagnosticBundleParts {
  doctor: unknown | null
  requirements: RequirementStatus[]
  teamEnv: TeamEnvDiagnostics | null
  logTails: {
    amuxd: string | null
    acpStream: string | null
  }
}

interface DaemonInfoBody {
  version?: string
  uptime_seconds?: number
  actor_id?: string
  backend_kind?: string
  cloud_auth?: { status?: string }
  configured_agent_types?: string[]
  agent_types_advertise?: {
    advertised?: boolean
    lastError?: string | null
  }
  mqtt_connected?: boolean
}

export interface DiagnosticReport {
  schemaVersion: 2
  generatedAt: string
  app: {
    version: string
    buildFlavor: string
    platform: string
    tauri: boolean
  }
  summary: { ok: number; warn: number; fail: number }
  checks: DiagnosticCheck[]
  findings: DiagnosticFinding[]
  causeCodes: DiagnosticCauseCode[]
  traces: TraceEvent[]
  details: {
    mqtt: ReturnType<typeof getMqttDiagSnapshot>
    daemon: {
      probe: DaemonHttpProbe
      info: DaemonInfoBody | null
    } | null
    requirements: RequirementStatus[]
    doctor: unknown | null
    teamEnv: TeamEnvDiagnostics | null
    startupTimeline: StartupStamp[]
    logTails: DiagnosticBundleParts['logTails']
    network: NetworkDiagnosticDetails
    consoleTail: ReturnType<typeof getConsoleEntries>
    runtimeState: Awaited<ReturnType<typeof getRuntimeStateSnapshot>> | null
  }
}

interface NetworkDiagnosticDetails {
  online: boolean | null
  /** Primary: the same unauthenticated endpoint the client uses (bootstrap public config). */
  cloudReachabilitySeries: CloudProbeSeries | null
  /** Supplementary: container liveness probe — may be blocked while /v1/* works. */
  healthzSeries: CloudProbeSeries | null
  bootstrapProbe: HttpProbeResult | null
  /** One-shot WSS/MQTT broker probe (Desktop only). */
  mqttProbe: MqttProbeResult | null
  /** Local daemon SSE fast-path (`GET /v1/live/events`). */
  daemonLiveConnected: boolean
  /** When Cloud API works but MQTT does not, yet SSE fast-path is up. */
  livePathHint: string | null
  mqttConfig: {
    brokerHost: string | null
    mqttUrl: string | null
    mqttPort: number | null
    mqttUseTls: boolean | null
    hasCredentials: boolean
  }
  mqttBridgeStatus: { connected: boolean; subscribedTopics: string[] } | null
  mqttEventSummary: MqttEventSummary
}

const AUTH_EXPIRY_WARN_SEC = 5 * 60
const CLOUD_JITTER_WARN_MS = 800
const CLOUD_LATENCY_WARN_MS = 3000

async function probeCloudEndpoints(baseUrl: string | undefined): Promise<{
  reachabilitySeries: CloudProbeSeries | null
  healthzSeries: CloudProbeSeries | null
  bootstrap: HttpProbeResult | null
}> {
  if (!baseUrl) {
    return { reachabilitySeries: null, healthzSeries: null, bootstrap: null }
  }
  const trimmed = baseUrl.replace(/\/+$/, '')
  const token = getSession()?.access_token?.trim()
  const [reachabilitySeries, healthzSeries, bootstrap] = await Promise.all([
    probeCloudEndpointSeries(trimmed, '/v1/config/public'),
    probeCloudHealthSeries(trimmed, 1),
    token
      ? probeHttp(`${trimmed}/v1/config/bootstrap`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      : Promise.resolve(null),
  ])
  return { reachabilitySeries, healthzSeries, bootstrap }
}

async function probeMqttForDiagnostics(teamId: string | null): Promise<MqttProbeResult | null> {
  if (!isTauri() || !teamId) return null

  const cfg = getEffectiveServerConfigSync()
  const brokerHost = cfg.mqttHost?.trim()
  if (!brokerHost) return null

  const session = getSession()
  const accessToken = session?.access_token?.trim()
  const userId = session?.user?.id
  if (!accessToken || !userId) return null

  const actorId = await resolveCurrentMemberActorId(teamId, userId, {
    currentTeamId: useCurrentTeamStore.getState().team?.id ?? null,
    currentMemberId: useCurrentTeamStore.getState().currentMember?.id ?? null,
  })
  if (!actorId) return null

  const brokerPort = cfg.mqttPort ?? (cfg.mqttUseTls ? 443 : 1883)
  const useTls = cfg.mqttUseTls ?? false
  const brokerUrl =
    cfg.mqttUrl ?? `${useTls ? 'mqtts' : 'mqtt'}://${brokerHost}:${brokerPort}`
  const configuredUsername = cfg.mqttUsername?.trim()
  const configuredPassword = cfg.mqttPassword?.trim()
  const useConfiguredCredentials = Boolean(configuredUsername && configuredPassword)

  return probeMqttBroker({
    brokerUrl,
    brokerHost,
    brokerPort,
    username: useConfiguredCredentials ? configuredUsername! : actorId,
    password: useConfiguredCredentials ? configuredPassword! : accessToken,
    teamId,
    useTls,
  })
}

function buildLivePathHint(input: {
  cloudReachable: boolean
  mqttConnected: boolean | null
  mqttProbeOk: boolean | null
  daemonLiveConnected: boolean
}): string | null {
  const cloudOk = input.cloudReachable
  const mqttBad = input.mqttProbeOk === false || input.mqttConnected === false
  if (!cloudOk || !mqttBad || !input.daemonLiveConnected) return null
  return 'Cloud API 可达，但 MQTT 不可用；本地 daemon SSE 快路径仍在线，同机流式可能正常而跨设备同步失败'
}

function buildMqttProbeCheck(probe: MqttProbeResult | null): DiagnosticCheck | null {
  if (!probe) return null
  if (probe.ok) {
    return {
      id: 'mqtt_probe',
      title: 'MQTT Broker 探测',
      status: 'ok',
      message: `Broker 可连接（${probe.latencyMs ?? '?'}ms）`,
    }
  }
  const authLike =
    probe.connackCode?.includes('BadUserNamePassword') ||
    probe.connackCode?.includes('NotAuthorized') ||
    probe.error?.toLowerCase().includes('badusername')
  if (authLike) {
    return {
      id: 'mqtt_probe',
      title: 'MQTT Broker 探测',
      status: 'fail',
      message: probe.error ?? 'MQTT 鉴权失败',
      hint: '请重新登录以刷新 JWT，或检查 bootstrap MQTT 凭据',
    }
  }
  return {
    id: 'mqtt_probe',
    title: 'MQTT Broker 探测',
    status: 'fail',
    message: probe.error ?? '无法连接 MQTT broker',
    hint: '检查 WSS/443 是否被防火墙或代理拦截',
    hintSection: 'general',
  }
}

function buildLivePathCheck(hint: string | null): DiagnosticCheck | null {
  if (!hint) return null
  return {
    id: 'live_path_split',
    title: 'Live 投递路径',
    status: 'warn',
    message: hint,
    hint: '跨设备消息同步依赖 MQTT；仅本机流式可用时请先修复 MQTT',
    hintSection: 'general',
  }
}

async function fetchDaemonInfo(baseUrl: string): Promise<DaemonInfoBody | null> {
  try {
    const resp = await fetch(`${baseUrl}/v1/info`)
    if (!resp.ok) return null
    return (await resp.json()) as DaemonInfoBody
  } catch {
    return null
  }
}

function summarize(checks: DiagnosticCheck[]): DiagnosticReport['summary'] {
  return checks.reduce(
    (acc, c) => {
      acc[c.status] += 1
      return acc
    },
    { ok: 0, warn: 0, fail: 0 },
  )
}

function buildNetworkOnlineCheck(online: boolean | null): DiagnosticCheck {
  if (online === false) {
    return {
      id: 'network_online',
      title: '设备网络',
      status: 'fail',
      message: '系统报告当前离线（navigator.onLine = false）',
      hint: '检查 Wi‑Fi / VPN / 代理后再试',
    }
  }
  return {
    id: 'network_online',
    title: '设备网络',
    status: 'ok',
    message: online === true ? '设备网络在线' : '设备网络状态未知',
  }
}

function buildCloudApiCheck(input: {
  reachabilitySeries: CloudProbeSeries | null
  healthzSeries: CloudProbeSeries | null
  bootstrap: HttpProbeResult | null
}): DiagnosticCheck {
  const { reachabilitySeries, healthzSeries, bootstrap } = input
  if (!reachabilitySeries) {
    return {
      id: 'cloud_api',
      title: 'Cloud API',
      status: 'warn',
      message: '未配置 Cloud API 地址',
      hint: '请检查构建配置或登录流程',
      hintSection: 'general',
    }
  }

  const seriesOk = reachabilitySeries.successRate > 0
  const bootstrapOk = bootstrap?.ok === true
  const healthzOk = (healthzSeries?.successRate ?? 0) > 0

  if (!seriesOk && !bootstrapOk) {
    const err =
      reachabilitySeries.samples.find((s) => !s.ok)?.error ??
      bootstrap?.error ??
      '无法连接 Cloud API'
    return {
      id: 'cloud_api',
      title: 'Cloud API',
      status: 'fail',
      message: err,
      hint: '设置 → 通用，检查服务器地址与网络',
      hintSection: 'general',
    }
  }

  const activeSeries = seriesOk ? reachabilitySeries : null
  const viaBootstrap = !seriesOk && bootstrapOk

  if (viaBootstrap) {
    return {
      id: 'cloud_api',
      title: 'Cloud API',
      status: 'ok',
      message: `Cloud API 正常（bootstrap ${bootstrap?.latencyMs ?? '?'}ms）`,
    }
  }

  const failed = reachabilitySeries.samples.filter((s) => !s.ok)
  if (failed.length > 0) {
    return {
      id: 'cloud_api',
      title: 'Cloud API',
      status: 'warn',
      message: `${failed.length}/${reachabilitySeries.samples.length} 次 API 探测失败（网络不稳定）`,
      hint: '可能是间歇性网络问题，稍后重试或切换网络',
      hintSection: 'general',
    }
  }

  if (activeSeries?.latencyAvg != null && activeSeries.latencyAvg > CLOUD_LATENCY_WARN_MS) {
    return {
      id: 'cloud_api',
      title: 'Cloud API',
      status: 'warn',
      message: `Cloud API 响应较慢（平均 ${activeSeries.latencyAvg}ms）`,
      hintSection: 'general',
    }
  }
  if (activeSeries?.jitterMs != null && activeSeries.jitterMs >= CLOUD_JITTER_WARN_MS) {
    return {
      id: 'cloud_api',
      title: 'Cloud API',
      status: 'warn',
      message: `Cloud API 延迟波动大（${activeSeries.latencyMin}–${activeSeries.latencyMax}ms，抖动 ${activeSeries.jitterMs}ms）`,
      hint: '网络不稳定，可能影响消息同步',
      hintSection: 'general',
    }
  }

  const healthzNote =
    !healthzOk && seriesOk ? '；/healthz 不可达（不影响业务）' : ''
  return {
    id: 'cloud_api',
    title: 'Cloud API',
    status: 'ok',
    message: `Cloud API 稳定（平均 ${activeSeries?.latencyAvg ?? '?'}ms，${reachabilitySeries.samples.length} 次探测${healthzNote}）`,
  }
}

function buildCloudBootstrapCheck(probe: HttpProbeResult | null): DiagnosticCheck {
  if (!getSession()?.access_token) {
    return {
      id: 'cloud_api_bootstrap',
      title: 'Cloud Bootstrap',
      status: 'warn',
      message: '未登录，跳过 bootstrap 探测',
    }
  }
  if (!probe) {
    return {
      id: 'cloud_api_bootstrap',
      title: 'Cloud Bootstrap',
      status: 'warn',
      message: '未探测 bootstrap 接口',
    }
  }
  if (probe.status === 401 || probe.status === 403) {
    return {
      id: 'cloud_api_bootstrap',
      title: 'Cloud Bootstrap',
      status: 'fail',
      message: `bootstrap 鉴权失败（HTTP ${probe.status}）`,
      hint: '请重新登录以刷新 MQTT 等配置',
    }
  }
  if (!probe.ok) {
    return {
      id: 'cloud_api_bootstrap',
      title: 'Cloud Bootstrap',
      status: 'fail',
      message: probe.error ?? '无法访问 /v1/config/bootstrap',
      hint: 'MQTT broker 配置可能无法更新',
      hintSection: 'general',
    }
  }
  return {
    id: 'cloud_api_bootstrap',
    title: 'Cloud Bootstrap',
    status: 'ok',
    message: `Bootstrap 接口正常（${probe.latencyMs ?? '?'}ms）`,
  }
}

function buildMqttConfigCheck(input: {
  mqttConnected: boolean | null
  hasAuthSession: boolean
}): DiagnosticCheck {
  const cfg = getEffectiveServerConfigSync()
  const host = parseBrokerHost(cfg.mqttUrl, cfg.mqttHost)
  const hasBootstrapCredentials = Boolean(cfg.mqttUsername && cfg.mqttPassword)
  const tls = cfg.mqttUseTls ? 'TLS' : '明文'
  const port = cfg.mqttPort ?? (cfg.mqttUseTls ? 443 : 1883)
  const endpoint = host ? `${host}:${port}（${tls}）` : null

  if (!host) {
    return {
      id: 'mqtt_config',
      title: 'MQTT Broker 配置',
      status: 'fail',
      message: '未配置 MQTT broker（bootstrap 可能未成功）',
      hint: '重新登录或设置 → 通用 → 重新连接 MQTT',
      hintSection: 'general',
    }
  }

  // Connected — config is clearly working regardless of credential source.
  if (input.mqttConnected === true) {
    return {
      id: 'mqtt_config',
      title: 'MQTT Broker 配置',
      status: 'ok',
      message: hasBootstrapCredentials
        ? `${endpoint}，bootstrap 凭据`
        : `${endpoint}，JWT 会话鉴权`,
    }
  }

  // Default auth path: actor id + access token — no bootstrap mqttPassword needed.
  if (!hasBootstrapCredentials && input.hasAuthSession) {
    return {
      id: 'mqtt_config',
      title: 'MQTT Broker 配置',
      status: 'ok',
      message: `${endpoint}，JWT 会话鉴权（无需 bootstrap 凭据）`,
    }
  }

  if (!hasBootstrapCredentials && !input.hasAuthSession) {
    return {
      id: 'mqtt_config',
      title: 'MQTT Broker 配置',
      status: 'warn',
      message: `Broker ${host} 已配置，但未登录且无 bootstrap 凭据`,
      hint: '请先登录以使用 JWT 鉴权连接 MQTT',
    }
  }

  return {
    id: 'mqtt_config',
    title: 'MQTT Broker 配置',
    status: 'ok',
    message: `${endpoint}，bootstrap 凭据已配置`,
  }
}

function buildMqttBridgeCheck(
  bridge: { connected: boolean; subscribedTopics?: string[] } | null,
): DiagnosticCheck {
  if (!bridge) {
    return {
      id: 'mqtt_bridge',
      title: 'MQTT 桥接层',
      status: 'warn',
      message: '无法读取 MQTT 桥接状态',
    }
  }
  const topics = bridge.subscribedTopics ?? []
  if (!bridge.connected) {
    return {
      id: 'mqtt_bridge',
      title: 'MQTT 桥接层',
      status: 'fail',
      message: '桥接层报告未连接',
      hintSection: 'general',
    }
  }
  if (topics.length === 0) {
    return {
      id: 'mqtt_bridge',
      title: 'MQTT 桥接层',
      status: 'warn',
      message: '已连接但未订阅任何主题（可能仍在初始化）',
      hintSection: 'general',
    }
  }
  return {
    id: 'mqtt_bridge',
    title: 'MQTT 桥接层',
    status: 'ok',
    message: `已连接，订阅 ${topics.length} 个主题`,
  }
}

function buildMqttStabilityCheck(summary: MqttEventSummary): DiagnosticCheck | null {
  if (summary.errorCount === 0 && summary.disconnectCount === 0) return null
  const parts: string[] = []
  if (summary.disconnectCount > 0) parts.push(`${summary.disconnectCount} 次断连`)
  if (summary.errorCount > 0) parts.push(`${summary.errorCount} 次错误`)
  const detail = parts.join('、')
  const suffix = summary.lastError ? `：${summary.lastError}` : ''
  if (summary.errorCount >= 3 || summary.disconnectCount >= 3) {
    return {
      id: 'mqtt_stability',
      title: 'MQTT 稳定性',
      status: 'fail',
      message: `近 ${summary.windowMinutes} 分钟 ${detail}${suffix}`,
      hint: '设置 → 通用 → 重新连接 MQTT',
      hintSection: 'general',
    }
  }
  return {
    id: 'mqtt_stability',
    title: 'MQTT 稳定性',
    status: 'warn',
    message: `近 ${summary.windowMinutes} 分钟 ${detail}${suffix}`,
    hintSection: 'general',
  }
}

function buildMqttDaemonSyncCheck(
  appConnected: boolean | null,
  daemonMqtt: boolean | undefined,
  daemonReachable: boolean,
): DiagnosticCheck | null {
  if (!daemonReachable || daemonMqtt === undefined) return null
  const app = appConnected === true
  if (app === daemonMqtt) {
    return {
      id: 'mqtt_daemon_sync',
      title: 'MQTT 双端一致性',
      status: 'ok',
      message: app ? '桌面与 daemon 均在线' : '桌面与 daemon 均未连接 MQTT',
    }
  }
  return {
    id: 'mqtt_daemon_sync',
    title: 'MQTT 双端一致性',
    status: 'warn',
    message: app
      ? '桌面已连接 MQTT，但 daemon 侧未连接'
      : 'daemon 已连接 MQTT，但桌面未连接',
    hint: '设置 → Daemon → 通用，检查 daemon MQTT 状态',
    hintSection: 'daemonGeneral',
  }
}

function buildAuthSessionCheck(mqttSnapshot: ReturnType<typeof getMqttDiagSnapshot>): DiagnosticCheck {
  const auth = mqttSnapshot.localState as {
    authSession?: {
      accessToken?: { expired?: boolean | null; secondsUntilExpiry?: number | null } | null
    } | null
  }
  const token = auth?.authSession?.accessToken
  if (!token) {
    return {
      id: 'auth_session',
      title: '登录会话',
      status: 'fail',
      message: '未检测到有效登录会话',
      hint: '请重新登录',
    }
  }
  if (token.expired === true) {
    return {
      id: 'auth_session',
      title: '登录会话',
      status: 'fail',
      message: '访问令牌已过期',
      hint: '请重新登录或刷新会话',
    }
  }
  const sec = token.secondsUntilExpiry
  if (typeof sec === 'number' && sec >= 0 && sec < AUTH_EXPIRY_WARN_SEC) {
    return {
      id: 'auth_session',
      title: '登录会话',
      status: 'warn',
      message: `访问令牌即将过期（${sec}s）`,
      hint: '建议重新登录以避免同步中断',
    }
  }
  return {
    id: 'auth_session',
    title: '登录会话',
    status: 'ok',
    message: '登录会话有效',
  }
}

function buildMqttCheck(): DiagnosticCheck {
  const { connected, lastError } = useMqttReconnectStore.getState()
  if (connected === true) {
    return {
      id: 'mqtt',
      title: 'MQTT 连接',
      status: 'ok',
      message: 'MQTT 已连接',
    }
  }
  if (connected === null) {
    return {
      id: 'mqtt',
      title: 'MQTT 连接',
      status: 'warn',
      message: 'MQTT 状态未知（正在检测）',
      hintSection: 'general',
    }
  }
  return {
    id: 'mqtt',
    title: 'MQTT 连接',
    status: 'fail',
    message: lastError ? `MQTT 未连接：${lastError}` : 'MQTT 未连接',
    hint: '设置 → 通用 → 重新连接',
    hintSection: 'general',
  }
}

function buildDaemonHttpCheck(probe: DaemonHttpProbe): DiagnosticCheck {
  if (probe.ok) {
    return {
      id: 'daemon_http',
      title: '本地 Daemon',
      status: 'ok',
      message: '本地 amuxd 运行正常',
    }
  }
  const messages: Record<DaemonHttpProbe extends { ok: false; reason: infer R } ? R : never, string> = {
    not_tauri: '非 Desktop 环境',
    port_file_missing: '未找到 daemon 配置（可能尚未初始化）',
    not_running: 'amuxd 未运行或无法访问',
    token_invalid: 'daemon 令牌无效，需重启应用',
    ipc_error: '无法读取 daemon 连接信息',
  }
  const reason = probe.ok ? 'not_running' : probe.reason
  const resetTrigger: DaemonResetTrigger | undefined =
    reason === 'token_invalid'
      ? 'daemon_http_token_invalid'
      : reason === 'port_file_missing'
        ? 'daemon_http_port_missing'
        : undefined
  return {
    id: 'daemon_http',
    title: '本地 Daemon',
    status: reason === 'not_tauri' ? 'warn' : 'fail',
    message: messages[reason as keyof typeof messages] ?? 'daemon 不可用',
    hint: '设置 → Daemon → 通用，检查 onboarding 状态',
    hintSection: 'daemonGeneral',
    resetTrigger,
  }
}

function buildDaemonInfoCheck(info: DaemonInfoBody | null, probeOk: boolean): DiagnosticCheck {
  if (!probeOk) {
    return {
      id: 'daemon_info',
      title: 'Daemon 云同步',
      status: 'warn',
      message: 'daemon 不可达，跳过云同步检查',
      hintSection: 'daemonGeneral',
    }
  }
  if (!info) {
    return {
      id: 'daemon_info',
      title: 'Daemon 云同步',
      status: 'warn',
      message: '无法读取 daemon 详情',
      hintSection: 'daemonGeneral',
      resetTrigger: 'daemon_info_unreadable',
    }
  }
  if (info.cloud_auth?.status === 'expired') {
    return {
      id: 'daemon_info',
      title: 'Daemon 云同步',
      status: 'fail',
      message: 'daemon 云认证已过期，需重新 onboarding',
      hint: '设置 → Daemon → 通用 → 重新绑定',
      hintSection: 'daemonGeneral',
      resetTrigger: 'daemon_cloud_auth_expired',
    }
  }
  const advertise = info.agent_types_advertise
  if (advertise?.advertised === false && advertise.lastError) {
    return {
      id: 'daemon_info',
      title: 'Daemon 云同步',
      status: 'warn',
      message: `Agent 类型上报失败：${advertise.lastError}`,
      hintSection: 'daemonGeneral',
    }
  }
  if (info.mqtt_connected === false) {
    return {
      id: 'daemon_info',
      title: 'Daemon 云同步',
      status: 'warn',
      message: 'daemon 侧 MQTT 未连接',
      hintSection: 'daemonGeneral',
    }
  }
  return {
    id: 'daemon_info',
    title: 'Daemon 云同步',
    status: 'ok',
    message: 'daemon 云认证与 MQTT 正常',
  }
}

function buildDependenciesCheck(requirements: RequirementStatus[]): DiagnosticCheck {
  const required = requirements.filter((r) => !r.optional)
  const missingRequired = required.filter((r) => !r.present)
  const missingOptional = requirements.filter((r) => r.optional && !r.present)

  if (missingRequired.length > 0) {
    return {
      id: 'dependencies',
      title: '系统依赖',
      status: 'fail',
      message: `缺少必需依赖：${missingRequired.map((r) => r.title).join('、')}`,
      hint: '设置 → 依赖，安装缺失组件',
      hintSection: 'deps',
    }
  }
  if (missingOptional.length > 0) {
    return {
      id: 'dependencies',
      title: '系统依赖',
      status: 'warn',
      message: `可选依赖未安装：${missingOptional.map((r) => r.title).join('、')}`,
      hintSection: 'deps',
    }
  }
  return {
    id: 'dependencies',
    title: '系统依赖',
    status: 'ok',
    message: '必需依赖均已就绪',
  }
}

function buildTeamEnvCheck(teamEnv: TeamEnvDiagnostics | null, teamId: string | null): DiagnosticCheck | null {
  if (!teamId) return null
  if (!teamEnv) {
    return {
      id: 'team_env',
      title: '团队环境同步',
      status: 'warn',
      message: '无法采集团队同步诊断（工作区路径缺失）',
      hintSection: 'envVars',
    }
  }
  if (!teamEnv.teamIdPresent) {
    return {
      id: 'team_env',
      title: '团队环境同步',
      status: 'warn',
      message: '未选择团队',
    }
  }
  const linkOk = teamEnv.linkExists && teamEnv.targetAccessible
  if (!linkOk) {
    return {
      id: 'team_env',
      title: '团队环境同步',
      status: 'fail',
      message: teamEnv.linkExists ? '团队目录软链无法访问' : '工作区未链接团队目录',
      hint: '侧边栏 → Knowledge 查看团队目录状态',
    }
  }
  if (!teamEnv.secretConfigured) {
    return {
      id: 'team_env',
      title: '团队环境同步',
      status: 'warn',
      message: '团队密钥未配置，共享变量可能无法加解密',
      hintSection: 'envVars',
    }
  }
  if (!teamEnv.secretsDirExists) {
    return {
      id: 'team_env',
      title: '团队环境同步',
      status: 'warn',
      message: 'daemon 尚未拉取团队 env 云缓存',
      hint: '确认 daemon 在跑；写入团队变量后会立即 reconcile，否则最长约 5 分钟',
      hintSection: 'envVars',
    }
  }
  return {
    id: 'team_env',
    title: '团队环境同步',
    status: 'ok',
    message: `团队目录与密钥配置正常（云缓存 ${teamEnv.secretFileCount} 个）`,
  }
}

function buildLocalAgentCheck(doctor: unknown | null): DiagnosticCheck {
  // Key and label must move together: claude-code had no arm, so a claude daemon
  // read opencode's `satisfied`/`version` out of the doctor report and presented
  // it under the label "OpenCode" — a pass/fail about a different program.
  const runtimeKey =
    localAgent === 'pi'
      ? 'pi'
      : localAgent === 'cursor'
        ? 'cursor'
        : localAgent === 'claude-code'
          ? 'claude'
          : 'opencode'
  const runtimeLabel =
    localAgent === 'pi'
      ? 'Pi'
      : localAgent === 'cursor'
        ? 'Cursor'
        : localAgent === 'claude-code'
          ? 'Claude Code'
          : 'OpenCode'
  const doc = doctor as Record<string, Record<string, unknown>> | null
  const runtime = doc?.[runtimeKey] as { satisfied?: boolean; version?: string } | undefined

  if (!runtime) {
    return {
      id: 'local_agent',
      title: `${runtimeLabel} 运行时`,
      status: 'warn',
      message: '无法读取本地 Agent 运行时状态',
      hintSection: 'deps',
    }
  }
  if (runtime.satisfied === true) {
    return {
      id: 'local_agent',
      title: `${runtimeLabel} 运行时`,
      status: 'ok',
      message: runtime.version ? `${runtimeLabel} ${runtime.version} 已就绪` : `${runtimeLabel} 已就绪`,
    }
  }
  return {
    id: 'local_agent',
    title: `${runtimeLabel} 运行时`,
    status: 'fail',
    message: `${runtimeLabel} 未安装或版本不满足要求`,
    hint: '设置 → 依赖，安装或升级运行时',
    hintSection: 'deps',
  }
}

function buildChecks(input: {
  online: boolean | null
  reachabilitySeries: CloudProbeSeries | null
  healthzSeries: CloudProbeSeries | null
  bootstrap: HttpProbeResult | null
  mqttSnapshot: ReturnType<typeof getMqttDiagSnapshot>
  mqttBridge: { connected: boolean; subscribedTopics?: string[] } | null
  mqttEventSummary: MqttEventSummary
  daemonProbe: DaemonHttpProbe
  daemonInfo: DaemonInfoBody | null
  requirements: RequirementStatus[]
  teamEnv: TeamEnvDiagnostics | null
  teamId: string | null
  doctor: unknown | null
  mqttProbe: MqttProbeResult | null
  daemonLiveConnected: boolean
  livePathHint: string | null
}): DiagnosticCheck[] {
  const mqttStoreConnected = useMqttReconnectStore.getState().connected
  const hasAuthSession = Boolean(getSession()?.access_token)
  const checks: DiagnosticCheck[] = [
    buildNetworkOnlineCheck(input.online),
    buildCloudApiCheck({
      reachabilitySeries: input.reachabilitySeries,
      healthzSeries: input.healthzSeries,
      bootstrap: input.bootstrap,
    }),
    buildCloudBootstrapCheck(input.bootstrap),
    buildAuthSessionCheck(input.mqttSnapshot),
    buildMqttConfigCheck({
      mqttConnected: mqttStoreConnected,
      hasAuthSession,
    }),
    buildMqttCheck(),
    buildMqttBridgeCheck(input.mqttBridge),
    buildDaemonHttpCheck(input.daemonProbe),
    buildDaemonInfoCheck(input.daemonInfo, input.daemonProbe.ok),
    buildDependenciesCheck(input.requirements),
    buildLocalAgentCheck(input.doctor),
  ]
  const mqttStability = buildMqttStabilityCheck(input.mqttEventSummary)
  if (mqttStability) checks.push(mqttStability)
  const mqttSync = buildMqttDaemonSyncCheck(
    mqttStoreConnected,
    input.daemonInfo?.mqtt_connected,
    input.daemonProbe.ok,
  )
  if (mqttSync) checks.push(mqttSync)
  const mqttProbeCheck = buildMqttProbeCheck(input.mqttProbe)
  if (mqttProbeCheck) checks.push(mqttProbeCheck)
  const livePathCheck = buildLivePathCheck(input.livePathHint)
  if (livePathCheck) checks.push(livePathCheck)
  const teamCheck = buildTeamEnvCheck(input.teamEnv, input.teamId)
  if (teamCheck) checks.push(teamCheck)
  return checks
}

async function collectRustBundle(): Promise<DiagnosticBundleParts | null> {
  if (!isTauri()) return null
  const teamId = useCurrentTeamStore.getState().team?.id ?? null
  const workspacePath = useWorkspaceStore.getState().workspacePath
  try {
    const raw = await invoke<{
      doctor: unknown | null
      requirements: RequirementStatus[]
      teamEnv: TeamEnvDiagnostics | null
      logTails: { amuxd: string | null; acpStream: string | null }
    }>('collect_diagnostic_bundle', {
      teamId,
      workspacePath,
      localAgent,
    })
    return raw
  } catch (err) {
    console.warn('[diagnostic-report] collect_diagnostic_bundle failed:', err)
    return {
      doctor: null,
      requirements: [],
      teamEnv: null,
      logTails: { amuxd: null, acpStream: null },
    }
  }
}

export async function collectDiagnosticReport(): Promise<DiagnosticReport> {
  useMqttReconnectStore.getState().ensureWired()

  const serverConfig = getEffectiveServerConfigSync()
  const online = typeof navigator !== 'undefined' ? navigator.onLine : null

  const [cloudEndpoints, daemonProbe, rustBundle, version, mqttBridge, mqttProbe] =
    await Promise.all([
    probeCloudEndpoints(serverConfig.cloudApiUrl),
    isTauri() ? probeDaemonHttp() : Promise.resolve({ ok: false, reason: 'not_tauri' } as const),
    collectRustBundle(),
    fetchAppVersion(),
    mqttStatus().catch(() => null),
    probeMqttForDiagnostics(useCurrentTeamStore.getState().team?.id ?? null),
  ])

  const daemonInfo =
    daemonProbe.ok ? await fetchDaemonInfo(daemonProbe.baseUrl) : null
  const mqttSnapshot = getMqttDiagSnapshot()
  const mqttEvents = (mqttSnapshot.events ?? []) as Array<{
    ts: string
    scope: string
    event: string
    data?: unknown
  }>
  const mqttEventSummary = summarizeMqttNetworkEvents(mqttEvents)
  const teamId = useCurrentTeamStore.getState().team?.id ?? null

  const requirements = rustBundle?.requirements ?? []
  const doctor = rustBundle?.doctor ?? null
  const teamEnv = rustBundle?.teamEnv ?? null
  const logTails = rustBundle?.logTails ?? { amuxd: null, acpStream: null }
  const consoleTail = getConsoleEntries({ limit: 200 })
  const runtimeState = await getRuntimeStateSnapshot().catch(() => null)

  const cfg = getEffectiveServerConfigSync()
  const daemonLiveConnected = getDaemonLiveConnected()
  const mqttStoreConnected = useMqttReconnectStore.getState().connected
  const cloudReachable =
    (cloudEndpoints.reachabilitySeries?.successRate ?? 0) > 0 ||
    cloudEndpoints.bootstrap?.ok === true
  const livePathHint = buildLivePathHint({
    cloudReachable,
    mqttConnected: mqttStoreConnected,
    mqttProbeOk: mqttProbe?.ok ?? null,
    daemonLiveConnected,
  })
  const networkDetails: NetworkDiagnosticDetails = {
    online,
    cloudReachabilitySeries: cloudEndpoints.reachabilitySeries,
    healthzSeries: cloudEndpoints.healthzSeries,
    bootstrapProbe: cloudEndpoints.bootstrap,
    mqttProbe,
    daemonLiveConnected,
    livePathHint,
    mqttConfig: {
      brokerHost: parseBrokerHost(cfg.mqttUrl, cfg.mqttHost),
      mqttUrl: cfg.mqttUrl ?? null,
      mqttPort: cfg.mqttPort ?? null,
      mqttUseTls: cfg.mqttUseTls ?? null,
      hasCredentials: Boolean(cfg.mqttUsername && cfg.mqttPassword),
    },
    mqttBridgeStatus: mqttBridge,
    mqttEventSummary,
  }

  const checks = buildChecks({
    online,
    reachabilitySeries: cloudEndpoints.reachabilitySeries,
    healthzSeries: cloudEndpoints.healthzSeries,
    bootstrap: cloudEndpoints.bootstrap,
    mqttSnapshot,
    mqttBridge,
    mqttEventSummary,
    daemonProbe,
    daemonInfo,
    requirements,
    teamEnv,
    teamId,
    doctor,
    mqttProbe,
    daemonLiveConnected,
    livePathHint,
  })

  const authToken = (
    mqttSnapshot.localState as {
      authSession?: {
        accessToken?: { expired?: boolean | null; secondsUntilExpiry?: number | null } | null
      } | null
    }
  )?.authSession?.accessToken
  const ctx = await collectDiagnosticContext({
    online,
    daemonProbe,
    daemonInfo,
    daemonLiveConnected,
    mqttDesktopConnected: mqttStoreConnected,
    mqttDesktopLastError: useMqttReconnectStore.getState().lastError ?? null,
    mqttSubscribedTopicCount: mqttBridge?.subscribedTopics?.length ?? 0,
    mqttProbe,
    mqttEventSummary,
    cloudReachable,
    bootstrapStatus: cloudEndpoints.bootstrap?.status ?? null,
    auth: {
      hasSession: Boolean(authToken),
      tokenExpired: authToken?.expired === true,
      secondsUntilExpiry:
        typeof authToken?.secondsUntilExpiry === 'number' ? authToken.secondsUntilExpiry : null,
    },
    teamEnv,
    runtimeState,
  })
  const findings = diagnose(ctx)
  const causeCodes = causeCodesFromFindings(findings)

  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    app: {
      version,
      buildFlavor: buildConfig.app.palette ?? 'default',
      platform: typeof navigator !== 'undefined' ? navigator.platform : 'unknown',
      tauri: isTauri(),
    },
    summary: summarize(checks),
    checks,
    findings,
    causeCodes,
    traces: ctx.traces,
    details: {
      mqtt: mqttSnapshot,
      daemon: isTauri()
        ? { probe: daemonProbe, info: daemonInfo }
        : null,
      requirements,
      doctor,
      teamEnv,
      startupTimeline: getStartupTimeline(),
      logTails,
      network: networkDetails,
      consoleTail,
      runtimeState,
    },
  }
}

function formatDiagnosticReportJson(report: DiagnosticReport): string {
  return JSON.stringify(report, null, 2)
}

export function diagnosticZipFilename(
  report: Pick<DiagnosticReport, 'causeCodes'>,
  stamp: Date = new Date(),
): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const cause = report.causeCodes?.[0]?.replace(/\./g, '-')
  const base = `teamclu-diag-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`
  return cause ? `${base}-${cause}.zip` : `${base}.zip`
}

export async function copyDiagnosticReport(report: DiagnosticReport): Promise<void> {
  const text = formatDiagnosticReportJson(report)
  await navigator.clipboard.writeText(text)
}

async function buildDiagnosticZipBytes(report: DiagnosticReport): Promise<Uint8Array> {
  const json = formatDiagnosticReportJson(report)
  const bytes = await invoke<number[]>('build_diagnostic_zip', { reportJson: json })
  return new Uint8Array(bytes)
}

export async function saveDiagnosticZip(report: DiagnosticReport): Promise<string | null> {
  if (!isTauri()) return null
  const { save } = await import('@tauri-apps/plugin-dialog')
  const { writeFile } = await import('@tauri-apps/plugin-fs')
  const { downloadDir } = await import('@tauri-apps/api/path')

  const filename = diagnosticZipFilename(report)
  const downloads = await downloadDir()
  const dest = await save({
    title: '导出诊断包',
    defaultPath: `${downloads}/${filename}`,
    filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
  })
  if (!dest) return null

  const zipBytes = await buildDiagnosticZipBytes(report)
  await writeFile(dest, zipBytes)
  return dest
}

export const GITHUB_ISSUES_URL = 'https://github.com/different-ai-studio/teamclu/issues'
