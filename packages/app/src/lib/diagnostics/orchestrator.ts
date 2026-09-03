import type {
  DiagnosticCauseCode,
  DiagnosticContext,
  DiagnosticFinding,
  FindingConfidence,
  FindingStatus,
  TraceEvent,
} from './types'

const STATUS_RANK: Record<FindingStatus, number> = { ok: 0, warn: 1, fail: 2 }

const SEND_STAGES = new Set<TraceEvent['stage']>([
  'send.enqueue',
  'outbox.attempt',
  'cloud.insert',
  'mqtt.publish',
  'runtime.ensure',
  'runtime.start',
  'local.ingest',
  'agent.turn',
])

function finding(
  partial: Omit<DiagnosticFinding, 'evidence'> & { evidence?: DiagnosticFinding['evidence'] },
): DiagnosticFinding {
  return { evidence: [], ...partial }
}

function mergeByCode(findings: DiagnosticFinding[]): DiagnosticFinding[] {
  const byCode = new Map<DiagnosticCauseCode, DiagnosticFinding>()
  for (const next of findings) {
    const prev = byCode.get(next.code)
    if (!prev || STATUS_RANK[next.status] >= STATUS_RANK[prev.status]) {
      byCode.set(next.code, next)
    }
  }
  return [...byCode.values()]
}

function lastErrorOf(traces: TraceEvent[], stage: TraceEvent['stage']): TraceEvent | undefined {
  return [...traces].reverse().find((event) => event.stage === stage && event.status === 'error')
}

function hasTerminalOk(traces: TraceEvent[], stage: TraceEvent['stage']): boolean {
  return traces.some(
    (event) =>
      event.stage === stage &&
      event.status === 'ok' &&
      !event.rawStage.endsWith('.begin'),
  )
}

function diagnoseModel(ctx: DiagnosticContext): DiagnosticFinding[] {
  if (!ctx.daemon.reachable) {
    return [
      finding({
        code: 'model.daemon_unreachable',
        symptom: 'model',
        status: 'fail',
        confidence: 'high',
        title: '本地 Daemon',
        message: '本地 amuxd 不可达，无法探测模型目录',
        nextAction: '设置 → Daemon → 通用，确认 amuxd 在跑',
        hintSection: 'daemonGeneral',
        evidence: [
          {
            source: 'daemon.healthz',
            summary: ctx.daemon.probeReason ?? 'daemon unreachable',
          },
        ],
      }),
    ]
  }

  const out: DiagnosticFinding[] = []
  const types = ctx.daemon.info?.configured_agent_types ?? []
  if (types.length === 0) {
    out.push(
      finding({
        code: 'model.provider_not_configured',
        symptom: 'model',
        status: 'warn',
        confidence: 'medium',
        title: '模型 Provider',
        message: 'daemon 未配置 agent backend',
        nextAction: '设置 → LLM，连接 provider',
        hintSection: 'llm',
        evidence: [
          {
            source: 'daemon.info',
            summary: 'configured_agent_types 为空',
            data: { configured_agent_types: types },
          },
        ],
      }),
    )
  }

  const catalog = ctx.catalog
  if (catalog?.status === 'models') {
    out.push(
      finding({
        code: 'model.catalog_ok',
        symptom: 'model',
        status: 'ok',
        confidence: 'high',
        title: '模型目录',
        message: `已探测到 ${catalog.models.length} 个可用模型（${catalog.backend}）`,
        nextAction: '无需处理',
        evidence: [
          {
            source: 'daemon.catalog',
            summary: `${catalog.backend}: ${catalog.models.length} models`,
          },
        ],
      }),
    )
  } else if (catalog?.status === 'empty') {
    out.push(
      finding({
        code: 'model.provider_not_configured',
        symptom: 'model',
        status: 'warn',
        confidence: 'high',
        title: '模型 Provider',
        message: '模型目录为空：尚未配置 provider，不是探测故障',
        nextAction: '设置 → LLM，连接 provider',
        hintSection: 'llm',
        evidence: [{ source: 'daemon.catalog', summary: `empty catalog (${catalog.backend})` }],
      }),
    )
  } else if (catalog?.status === 'error') {
    const probe = catalog.message
    const authLike = /auth|token|unauthorized|401/i.test(probe)
    out.push(
      finding({
        code: 'model.backend_probe_failed',
        symptom: 'model',
        status: 'fail',
        confidence: 'high',
        title: '模型探测',
        message: probe,
        nextAction: authLike
          ? '设置 → LLM，重新连接 provider（provider 鉴权失败）'
          : '设置 → LLM，重新连接 provider',
        hintSection: 'llm',
        evidence: [{ source: 'daemon.catalog', summary: probe }],
      }),
    )
  } else {
    out.push(
      finding({
        code: 'model.catalog_unknown',
        symptom: 'model',
        status: 'warn',
        confidence: 'low',
        title: '模型目录',
        message: '使用上次缓存，或实时探测无结论',
        nextAction: '稍后重试；若持续，导出诊断包',
        evidence: [{ source: 'daemon.catalog', summary: 'catalog unknown' }],
      }),
    )
  }

  if (ctx.teamLlm && ctx.teamLlm.enabled === false && !ctx.teamLlm.baseUrl) {
    out.push(
      finding({
        code: 'model.team_gateway_unconfigured',
        symptom: 'model',
        status: 'warn',
        confidence: 'medium',
        title: '团队 Gateway',
        message: '团队 LLM gateway 未配置',
        nextAction: '设置 → LLM，为团队配置 gateway',
        hintSection: 'llm',
        evidence: [{ source: 'cloud.api', summary: 'team llm disabled without baseUrl' }],
      }),
    )
  }

  return out
}

function diagnoseSend(ctx: DiagnosticContext): DiagnosticFinding[] {
  const sendTraces = ctx.traces.filter((event) => SEND_STAGES.has(event.stage))
  if (ctx.outbox.length === 0 && sendTraces.length === 0) return []

  const out: DiagnosticFinding[] = []
  const recentOutbox = [...ctx.outbox]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 20)
  const failed = recentOutbox.find((entry) => entry.state === 'failed')
  if (failed) {
    out.push(
      finding({
        code: 'send.outbox_failed',
        symptom: 'send',
        status: 'fail',
        confidence: 'high',
        title: '消息发送',
        message: failed.lastError ? `outbox 发送失败：${failed.lastError}` : 'outbox 发送失败',
        nextAction: '检查网络后重试该消息',
        evidence: [
          {
            source: 'outbox',
            summary: `${failed.messageId} failed`,
            at: failed.updatedAt,
            data: {
              lastError: failed.lastError,
              attemptCount: failed.attemptCount,
              sessionId: failed.sessionId,
            },
          },
        ],
      }),
    )
  }

  const cloudFail = lastErrorOf(sendTraces, 'cloud.insert')
  if (cloudFail) {
    out.push(
      finding({
        code: 'send.cloud_insert_failed',
        symptom: 'send',
        status: 'fail',
        confidence: 'high',
        title: 'Cloud 写入',
        message: cloudFail.errorCode ?? 'Cloud insert 失败',
        nextAction: '检查 Cloud API 与登录状态后重试',
        evidence: [{ source: 'trace', summary: cloudFail.rawStage, at: cloudFail.startedAt }],
      }),
    )
  }

  const mqttFail = lastErrorOf(sendTraces, 'mqtt.publish')
  if (mqttFail) {
    const localFast = mqttFail.path === 'local_fast'
    out.push(
      finding({
        code: 'send.mqtt_publish_failed',
        symptom: 'send',
        status: localFast ? 'warn' : 'fail',
        confidence: 'high',
        title: 'MQTT 投递',
        message: localFast
          ? `本机已投递，MQTT 扇出失败（best-effort）：${mqttFail.errorCode ?? 'publish failed'}`
          : (mqttFail.errorCode ?? 'MQTT publish 失败'),
        nextAction: '设置 → 通用 → 重新连接 MQTT',
        hintSection: 'general',
        evidence: [
          {
            source: 'trace',
            summary: mqttFail.rawStage,
            at: mqttFail.startedAt,
            data: { path: mqttFail.path },
          },
        ],
      }),
    )
  }

  const ingestFail = lastErrorOf(sendTraces, 'local.ingest')
  if (ingestFail) {
    out.push(
      finding({
        code: 'send.local_ingest_failed',
        symptom: 'send',
        status: 'fail',
        confidence: 'high',
        title: '本地投递',
        message: ingestFail.errorCode ?? 'local ingest 失败',
        nextAction: '检查本地 daemon 后重试',
        hintSection: 'daemonGeneral',
        evidence: [{ source: 'trace', summary: ingestFail.rawStage, at: ingestFail.startedAt }],
      }),
    )
  }

  const runtimeFail =
    lastErrorOf(sendTraces, 'runtime.ensure') ?? lastErrorOf(sendTraces, 'runtime.start')
  if (runtimeFail) {
    out.push(
      finding({
        code: 'send.runtime_ensure_failed',
        symptom: 'send',
        status: 'fail',
        confidence: 'high',
        title: 'Agent Runtime',
        message: runtimeFail.errorCode ?? 'runtime ensure / start 失败',
        nextAction: '检查工作区绑定与模型是否可用',
        hintSection: 'daemonRuntimes',
        evidence: [{ source: 'trace', summary: runtimeFail.rawStage, at: runtimeFail.startedAt }],
      }),
    )
  }

  const delivered =
    recentOutbox.some((entry) => entry.state === 'delivered') ||
    hasTerminalOk(sendTraces, 'outbox.attempt')
  const turnError = ctx.runtimeActivity.lastTurnError
  const turnTraceError = lastErrorOf(sendTraces, 'agent.turn')
  const combinedTurnError = turnError ?? turnTraceError?.errorCode ?? null

  if (delivered && ctx.runtimeActivity.active === false) {
    out.push(
      finding({
        code: 'agent.runtime_inactive',
        symptom: 'send',
        status: 'fail',
        confidence: 'medium',
        title: 'Agent Runtime',
        message: '消息已送达，但 agent runtime 未进入 ACTIVE',
        nextAction: '检查 workspace binding 与 backend 是否启动',
        hintSection: 'daemonRuntimes',
        evidence: [{ source: 'runtime.state', summary: 'runtime not ACTIVE' }],
      }),
    )
  } else if (delivered && ctx.runtimeActivity.active === true && combinedTurnError) {
    const timeoutLike = /timeout|rate.?limit|429/i.test(combinedTurnError)
    out.push(
      finding({
        code: timeoutLike ? 'agent.turn_timeout' : 'agent.model_provider_error',
        symptom: 'send',
        status: 'fail',
        confidence: 'medium',
        title: timeoutLike ? '模型超时' : '模型 Provider',
        message: combinedTurnError,
        nextAction: timeoutLike
          ? '稍后重试，或更换模型'
          : '设置 → LLM，检查 provider 配额与鉴权',
        hintSection: 'llm',
        evidence: [{ source: 'runtime.state', summary: combinedTurnError }],
      }),
    )
  } else if (delivered && ctx.runtimeActivity.active === true && !combinedTurnError) {
    out.push(
      finding({
        code: 'send.delivered_no_turn',
        symptom: 'send',
        status: 'warn',
        confidence: 'low',
        title: '等待回复',
        message: '消息已送达，尚未观察到 agent turn；可能仍在跑或模型无响应',
        nextAction: '稍等后查看会话；若一直无回复，导出诊断包',
        evidence: [{ source: 'outbox', summary: 'delivered without turn event' }],
      }),
    )
  }

  const hasProblem = out.some((item) => item.status !== 'ok')
  if (!hasProblem) {
    out.push(
      finding({
        code: 'send.path_ok',
        symptom: 'send',
        status: 'ok',
        confidence: 'medium',
        title: '发送链路',
        message: '最近一次发送未发现投递或 runtime 故障',
        nextAction: '无需处理',
        evidence: [{ source: 'trace', summary: `${sendTraces.length} send traces` }],
      }),
    )
  }

  return out
}

function isMqttAuthFailure(ctx: DiagnosticContext): boolean {
  if (ctx.auth.tokenExpired) return true
  const probe = ctx.mqtt.probe
  if (!probe || probe.ok) return false
  const haystack = `${probe.connackCode ?? ''} ${probe.error ?? ''}`.toLowerCase()
  return (
    haystack.includes('badusernamepassword') ||
    haystack.includes('notauthorized') ||
    haystack.includes('401')
  )
}

function diagnoseRealtime(ctx: DiagnosticContext): DiagnosticFinding[] {
  const out: DiagnosticFinding[] = []
  const probe = ctx.mqtt.probe
  const mqttUnavailable = probe?.ok === false || ctx.mqtt.desktopConnected === false

  if (isMqttAuthFailure(ctx)) {
    out.push(
      finding({
        code: 'realtime.mqtt_auth_failed',
        symptom: 'realtime',
        status: 'fail',
        confidence: 'high',
        title: 'MQTT 鉴权',
        message: probe?.error ?? 'MQTT 鉴权失败或访问令牌已过期',
        nextAction: '请重新登录以刷新 JWT',
        evidence: [
          {
            source: 'mqtt.probe',
            summary: probe?.connackCode ?? probe?.error ?? 'auth failed',
          },
        ],
      }),
    )
  } else if (probe && !probe.ok) {
    out.push(
      finding({
        code: 'realtime.mqtt_network_failed',
        symptom: 'realtime',
        status: 'fail',
        confidence: 'high',
        title: 'MQTT 网络',
        message: probe.error ?? '无法连接 MQTT broker',
        nextAction: '检查 WSS/443 是否被防火墙或代理拦截',
        hintSection: 'general',
        evidence: [{ source: 'mqtt.probe', summary: probe.error ?? 'probe failed' }],
      }),
    )
  }

  if (ctx.mqtt.desktopConnected === true && ctx.mqtt.daemonConnected === false) {
    out.push(
      finding({
        code: 'realtime.mqtt_desktop_only',
        symptom: 'realtime',
        status: 'warn',
        confidence: 'high',
        title: 'MQTT 双端一致性',
        message: '桌面已连接 MQTT，但 daemon 侧未连接',
        nextAction: '设置 → Daemon → 通用，检查 daemon MQTT 状态',
        hintSection: 'daemonGeneral',
        evidence: [{ source: 'mqtt.snapshot', summary: 'desktop connected, daemon disconnected' }],
      }),
    )
  } else if (ctx.mqtt.desktopConnected === false && ctx.mqtt.daemonConnected === true) {
    out.push(
      finding({
        code: 'realtime.mqtt_daemon_only',
        symptom: 'realtime',
        status: 'warn',
        confidence: 'high',
        title: 'MQTT 双端一致性',
        message: 'daemon 已连接 MQTT，但桌面未连接',
        nextAction: '设置 → 通用 → 重新连接 MQTT',
        hintSection: 'general',
        evidence: [{ source: 'mqtt.snapshot', summary: 'daemon connected, desktop disconnected' }],
      }),
    )
  }

  if (ctx.cloud.reachable && mqttUnavailable && ctx.daemon.liveConnected) {
    out.push(
      finding({
        code: 'realtime.sse_fallback',
        symptom: 'realtime',
        status: 'warn',
        confidence: 'high',
        title: 'Live 投递路径',
        message: 'Cloud API 可达，但 MQTT 不可用；本地 daemon SSE 快路径仍在线，同机流式可能正常而跨设备同步失败',
        nextAction: '跨设备消息同步依赖 MQTT；仅本机流式可用时请先修复 MQTT',
        hintSection: 'general',
        evidence: [{ source: 'mqtt.snapshot', summary: 'SSE up, MQTT down' }],
      }),
    )
  }

  if (ctx.mqtt.desktopConnected === true && ctx.mqtt.subscribedTopicCount === 0) {
    out.push(
      finding({
        code: 'realtime.topic_empty',
        symptom: 'realtime',
        status: 'warn',
        confidence: 'medium',
        title: 'MQTT 订阅',
        message: '已连接但未订阅任何主题（可能仍在初始化）',
        nextAction: '等待初始化完成；若持续为空，重新登录',
        evidence: [{ source: 'mqtt.snapshot', summary: 'subscribedTopics empty' }],
      }),
    )
  }

  const desktopOk = ctx.mqtt.desktopConnected === true
  const daemonOk = ctx.mqtt.daemonConnected !== false
  const probeOk = !probe || probe.ok
  if (out.length === 0 && desktopOk && daemonOk && probeOk) {
    out.push(
      finding({
        code: 'realtime.ok',
        symptom: 'realtime',
        status: 'ok',
        confidence: 'high',
        title: '实时通道',
        message: '桌面与 daemon MQTT 正常',
        nextAction: '无需处理',
        evidence: [{ source: 'mqtt.snapshot', summary: 'mqtt ok' }],
      }),
    )
  }

  return out
}

function diagnoseAuthSync(ctx: DiagnosticContext): DiagnosticFinding[] {
  const out: DiagnosticFinding[] = []
  if (!ctx.auth.hasSession || ctx.auth.tokenExpired) {
    out.push(
      finding({
        code: 'auth.session_invalid',
        symptom: 'auth_sync',
        status: 'fail',
        confidence: 'high',
        title: '登录会话',
        message: ctx.auth.tokenExpired ? '访问令牌已过期' : '未检测到有效登录会话',
        nextAction: '请重新登录',
        evidence: [{ source: 'mqtt.snapshot', summary: 'auth session missing or expired' }],
      }),
    )
  }
  if (ctx.daemon.info?.cloud_auth?.status === 'expired') {
    out.push(
      finding({
        code: 'auth.daemon_cloud_expired',
        symptom: 'auth_sync',
        status: 'fail',
        confidence: 'high',
        title: 'Daemon 云同步',
        message: 'daemon 云认证已过期，需重新 onboarding',
        nextAction: '设置 → Daemon → 通用 → 重新绑定',
        hintSection: 'daemonGeneral',
        evidence: [{ source: 'daemon.info', summary: 'cloud_auth expired' }],
      }),
    )
  }
  const team = ctx.teamEnv
  if (team && team.teamIdPresent && !(team.linkExists && team.targetAccessible)) {
    out.push(
      finding({
        code: 'sync.team_link_broken',
        symptom: 'auth_sync',
        status: 'fail',
        confidence: 'high',
        title: '团队环境同步',
        message: team.linkExists ? '团队目录软链无法访问' : '工作区未链接团队目录',
        nextAction: '侧边栏 → Knowledge 查看团队目录状态',
        evidence: [{ source: 'daemon.info', summary: 'team link missing or inaccessible' }],
      }),
    )
  }
  return out
}

export function diagnose(ctx: DiagnosticContext): DiagnosticFinding[] {
  return mergeByCode([
    ...diagnoseModel(ctx),
    ...diagnoseSend(ctx),
    ...diagnoseRealtime(ctx),
    ...diagnoseAuthSync(ctx),
  ])
}
