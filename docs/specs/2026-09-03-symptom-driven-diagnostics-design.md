# Symptom-driven diagnostics（Phase 1 + 2 数据层）

- **Date**: 2026-09-03
- **Status**: IMPLEMENTED — Phase 1 + 2 数据层 + Phase 3 症状 UI + Phase 4 修复动作
- **Scope**: `packages/app/src/lib/diagnostics/`（新）、`packages/app/src/lib/diagnostic-report.ts`、`packages/app/src/lib/session-flow-log.ts`、发送链路若干写入点、设置页诊断 UI
- **Non-scope**: 失败气泡入口、daemon 新增诊断 endpoint、Expo / iOS 客户端
- **Related**: `packages/app/src/lib/local-daemon-model-catalog.ts`、`packages/app/src/lib/mqtt-diagnostics.ts`、`packages/app/src/services/outbox-sender.ts`

---

## 0. 一句话

不重做监控平台。把现有一键诊断从「检查清单」升级成 **cause code + 证据 + 下一步**，并用 `messageId` 把一次发送串成可过滤的 trace。这一期只改数据层：运行诊断后，导出的报告里能回答「卡在哪一段」。设置页交互不变。

---

## 1. 目标

| # | 要求 | 落点 |
|---|------|------|
| 1 | 用户（或支持）能从一份报告读出明确结论 | `DiagnosticFinding[]` 进 `DiagnosticReport` |
| 2 | `empty` 和 `probe_error` 不得混成同一种失败 | 模型流直接消费 `LocalDaemonCatalogOutcome` |
| 3 | 一次发送的生命周期可按 `sessionId` / `messageId` 过滤 | in-memory `TraceEvent` ring（800 条） |
| 4 | 不要求用户先开 debug 模式 | `sessionFlowLog` 顺带写入 trace；诊断始终可读 |
| 5 | 现有检查、导出 zip、重置 daemon 入口继续工作 | `DiagnosticCheck[]` 保留；`schemaVersion` 升到 2 |
| 6 | 设置页不加 tab、不加气泡、不加新按钮 | `DiagnosticsSection.tsx` 不改交互 |

验收时，导出的 JSON 必须能回答：

1. 消息有没有发出去？
2. agent runtime 有没有启动？
3. 模型 provider 有没有响应？
4. 实时通道失败在 Desktop、daemon、broker 还是网络？

---

## 2. 今天长什么样

| 资产 | 事实 | 缺口 |
|------|------|------|
| `collectDiagnosticReport()` | 已探针 Cloud / daemon `/v1/healthz` `/v1/info` / MQTT snapshot / broker probe / SSE / 团队目录 | 输出是 `DiagnosticCheck[]` 清单，没有 cause code |
| `buildChecks()` | 命令式拼检查项，带 `hint` / `hintSection` / `resetTrigger` | 不是纯函数编排器，无法按 symptom 复用 |
| `sessionFlowLog` | outbox / runtime ensure / MQTT / local ingest 都已打点 | 只 `console.info`，没有 ring，不能按 message 过滤 |
| `LocalDaemonCatalogOutcome` | 已区分 `models` / `empty` / `error` / `unknown` | 一键诊断完全没消费它 |
| `livePathHint` | 已能说「MQTT 挂、SSE 还在」 | 只是一句 hint，不是一等 finding |
| `OutboxEntry` | `pending` / `inFlight` / `delivered` / `failed` + `lastError` | 诊断报告不读 outbox |
| `recordMqttDiag` | 300 条 MQTT 事件 ring | 只覆盖 broker 事件，不是发送生命周期 |

---

## 3. 决策记录

### D1 — 就地升级，不并行第二套诊断

新增 `packages/app/src/lib/diagnostics/`，现有 `collectDiagnosticReport()` 采集完上下文后调用 orchestrator。`DiagnosticCheck[]` 继续给现有设置页用；`findings` + `traces` 是报告的新字段。不维护两套探针。

### D2 — 这一期只做数据层

设置页仍是「运行诊断 → 检查列表 → 导出」。findings 和 traces 出现在：

- `DiagnosticReport` 对象（内存 / store）
- 复制的 JSON
- 导出的 zip

不改 `DiagnosticsSection` 的按钮、tab、入口。Phase 3 再把 findings 做成结论卡和三个 symptom tab。

### D3 — trace 写入：增强 `sessionFlowLog`，关键路径再补显式 `recordTrace`

已有 `sessionFlowLog(..., { messageId, sessionId })` 的调用点足够密。适配规则：

- payload 含 `messageId` 或 `sessionId` 才入 ring
- stage 后缀映射 status：`.ok` / `.done` / `.delivered` → `ok`；`.failed` / log level `error` → `error`；`.begin` 也写入 ring，status 固定为 `ok`（表示「这个阶段开始了」，不是成功结论；orchestrator 只根据后续 `.ok` / `.failed` / `.done` 归因）；无法识别后缀则 `ok`（info）或 `error`（error level）
- `durationMs`：把 `rawStage` 最后一段（`begin` / `ok` / `done` / `failed` / `delivered`）剥掉得到前缀。同一 `traceId` + 同一前缀下，最近一条尚未配对的 `.begin` 与随后的终态配对，终态带上间隔毫秒。对不上 begin 就省略 `durationMs`，不猜

仅这些还不够归因的点，显式 `recordTrace()`：

- outbox `attempt` 终态（`delivered` / `failed`）——必须带 `path: local_fast | remote`
- local ingest 成功 / 失败
- runtime ensure 失败（已有 `sessionFlowError`，适配器会收）

禁止为了诊断再铺一套平行日志 API 替代 `sessionFlowLog`。`recordTrace` 是补充，不是第二套 stage 名。

### D4 — orchestrator 是纯函数

```ts
diagnose(ctx: DiagnosticContext): DiagnosticFinding[]
```

采集（网络、daemon、MQTT probe、catalog、outbox 快照、trace ring）留在 `collectDiagnosticReport()`。编排器只读 `ctx`，可单测，不 `fetch`、不碰 store。

一键诊断跑全部 symptom（`model` + `send` + `realtime` + `auth_sync`）。Phase 3 再按 tab 传入单个 symptom。

### D5 — `empty` 不是故障

模型流四种结果必须原样保留：

| catalog outcome | finding |
|-----------------|---------|
| `models` | `model.catalog_ok`（`ok`） |
| `empty` | `model.provider_not_configured`（`warn`，不是 `fail`） |
| `error`（含 `probe_error`） | `model.backend_probe_failed`（`fail`） |
| `unknown` 且 daemon 不可达 | `model.daemon_unreachable`（`fail`） |
| `unknown` 且 daemon 可达 | `model.catalog_unknown`（`warn`：用了缓存或探测无结论） |

禁止把「没配 provider」渲染成「探测失败」。

### D6 — ring 容量 800，进程内，不落盘

与 `mqtt-diagnostics`（300）和 `console-capture` 同类。诊断不要求重启后仍在。测试可 `clearTraceBuffer()`。

### D7 — 不改 daemon 契约

模型诊断调用已有 `GET /v1/workspaces/:id/model-catalog` 和 `/v1/healthz`、`/v1/info`。不新增 daemon 诊断 RPC。团队 gateway 模型：若当前 workspace 有 Cloud LLM config，orchestrator 读 `ctx.teamLlm`（采集时带上，没有则跳过该项）。

---

## 4. 数据模型

全部类型放在 `packages/app/src/lib/diagnostics/types.ts`。

### 4.1 TraceEvent

```ts
type TraceStatus = 'ok' | 'error' | 'timeout' | 'skipped'

type TraceStage =
  | 'send.enqueue'
  | 'outbox.attempt'
  | 'cloud.insert'
  | 'mqtt.publish'
  | 'runtime.ensure'
  | 'runtime.start'
  | 'local.ingest'
  | 'agent.turn'
  | 'session.flow' // 无法映射到上面时的兜底，stage 细节在 rawStage

interface TraceEvent {
  traceId: string          // messageId；没有 messageId 时用 `session:${sessionId}`
  sessionId?: string
  actorId?: string
  stage: TraceStage
  rawStage: string         // 原始 sessionFlowLog stage，例如 outbox_sender.mqtt_publish.done
  status: TraceStatus
  startedAt: string        // ISO
  durationMs?: number
  errorCode?: string
  attempt?: number
  path?: 'local_fast' | 'remote'
  detail?: Record<string, unknown> // 已脱敏；禁止正文、token、密码
}
```

`sessionFlowLog` → `TraceStage` 映射（写死在适配器里，新 stage 默认 `session.flow`）：

| rawStage 前缀 | TraceStage |
|---------------|------------|
| `outbox.enqueue` / `send.outbox_enqueue` | `send.enqueue` |
| `outbox_sender.attempt` | `outbox.attempt` |
| `outbox_sender.message_insert` | `cloud.insert` |
| `outbox_sender.mqtt_publish` | `mqtt.publish` |
| `outbox_sender.runtime_ensure` / `ensure_agent_runtime` / `ensure_runtime_then_set_model` | `runtime.ensure` |
| `outbox_sender.local_runtime_start` / `runtime_start` | `runtime.start` |
| `outbox_sender.local_ingest` | `local.ingest` |

`agent.turn` 这一期只在前端能观察到的失败上写（runtime store 的 turn error / timeout，若采集时能读到）。不改 daemon 去补 turn 事件。

### 4.2 DiagnosticFinding

```ts
type FindingStatus = 'ok' | 'warn' | 'fail'
type FindingConfidence = 'high' | 'medium' | 'low'
type DiagnosticSymptom = 'model' | 'send' | 'realtime' | 'auth_sync'

type DiagnosticCauseCode =
  // model
  | 'model.daemon_unreachable'
  | 'model.provider_not_configured'
  | 'model.backend_probe_failed'
  | 'model.catalog_ok'
  | 'model.catalog_unknown'
  | 'model.team_gateway_unconfigured'
  // send
  | 'send.outbox_failed'
  | 'send.cloud_insert_failed'
  | 'send.mqtt_publish_failed'
  | 'send.runtime_ensure_failed'
  | 'send.local_ingest_failed'
  | 'send.delivered_no_turn'
  | 'send.path_ok'
  // agent (send 流后半段)
  | 'agent.turn_timeout'
  | 'agent.model_provider_error'
  | 'agent.runtime_inactive'
  // realtime
  | 'realtime.mqtt_auth_failed'
  | 'realtime.mqtt_network_failed'
  | 'realtime.mqtt_desktop_only'
  | 'realtime.mqtt_daemon_only'
  | 'realtime.sse_fallback'
  | 'realtime.topic_empty'
  | 'realtime.ok'
  // auth / team
  | 'auth.session_invalid'
  | 'auth.daemon_cloud_expired'
  | 'sync.team_link_broken'

interface DiagnosticEvidence {
  source: 'daemon.info' | 'daemon.healthz' | 'daemon.catalog' | 'outbox' | 'trace' | 'mqtt.probe' | 'mqtt.snapshot' | 'cloud.api' | 'runtime.state'
  summary: string
  at?: string
  data?: Record<string, unknown> // 已脱敏
}

interface DiagnosticFinding {
  code: DiagnosticCauseCode
  symptom: DiagnosticSymptom
  status: FindingStatus
  confidence: FindingConfidence
  title: string
  message: string
  nextAction: string
  evidence: DiagnosticEvidence[]
  hintSection?: SettingsSection
}
```

`title` / `message` / `nextAction` 用中文，和现有诊断文案一致。`code` 是稳定英文，供导出统计。

### 4.3 DiagnosticContext（orchestrator 输入）

采集层组好，字段都是已完成的快照，不是 Promise：

```ts
interface DiagnosticContext {
  online: boolean | null
  daemon: {
    reachable: boolean
    probeReason?: string
    info: DaemonInfoBody | null
    liveConnected: boolean
  }
  catalog: LocalDaemonCatalogOutcome | null
  teamLlm: { enabled: boolean; baseUrl: string | null } | null
  outbox: Array<Pick<OutboxEntry, 'messageId' | 'sessionId' | 'state' | 'lastError' | 'attemptCount' | 'updatedAt'>>
  traces: TraceEvent[]
  mqtt: {
    desktopConnected: boolean | null
    desktopLastError: string | null
    subscribedTopicCount: number
    daemonConnected: boolean | undefined
    probe: MqttProbeResult | null
    eventSummary: MqttEventSummary
  }
  cloud: {
    reachable: boolean
    bootstrapStatus: number | null
  }
  auth: {
    hasSession: boolean
    tokenExpired: boolean
    secondsUntilExpiry: number | null
  }
  teamEnv: TeamEnvDiagnostics | null
  runtimeState: Awaited<ReturnType<typeof getRuntimeStateSnapshot>> | null
}
```

### 4.4 DiagnosticReport 扩展

```ts
interface DiagnosticReport {
  schemaVersion: 2
  // …现有字段不变
  findings: DiagnosticFinding[]
  traces: TraceEvent[]          // 本次采集时 ring 的完整快照（最多 800）
}
```

现有 `diagnostic-report.test.ts` 断言 `schemaVersion: 1` 的地方改成 `2`，并断言 `findings` / `traces` 为数组。zip / 复制走现有 `JSON.stringify`，无需新文件格式。

---

## 5. 三条诊断流（orchestrator）

每条流返回 1..n 条 finding。一键诊断合并四条流（加上 `auth_sync`）。同一 `code` 只出现一次；更严重的 status 覆盖较轻的。

### 5.1 获取不了模型（`symptom: model`）

判定顺序固定：

1. `ctx.daemon.reachable === false` → `model.daemon_unreachable`（`fail`，high）。停。
2. `info.configured_agent_types` 为空或不存在 → `model.provider_not_configured`（`warn`，medium），证据写 `/v1/info`。不停，继续 catalog（backend 可能仍能探）。
3. 读 `ctx.catalog`：
   - `models` → `model.catalog_ok`
   - `empty` → `model.provider_not_configured`（`warn`，high）。**不是 fail。**
   - `error` → `model.backend_probe_failed`（`fail`，high），`message` 带上 `probe_error` 原文。
   - `unknown` → `model.catalog_unknown`（`warn`，low）：「使用上次缓存或实时探测无结论」。
4. 若 `ctx.teamLlm` 存在且 `enabled === false` 且无 `baseUrl`，或团队会话需要 gateway 却未配置 → `model.team_gateway_unconfigured`（`warn`）。没有 `teamLlm` 快照则跳过，不猜测。

`nextAction` 示例：

- unreachable → 设置 → Daemon → 通用，确认 amuxd 在跑
- not_configured → 设置 → LLM，连接 provider
- probe_failed → 设置 → LLM，重新连接 provider；若文案含 token/auth，明确写「provider 鉴权失败」
- catalog_unknown → 稍后重试；若持续，导出诊断包

### 5.2 发送后没有回复（`symptom: send`）

分界：**消息是否已投递** vs **agent 是否开始 turn**。

1. 看 `ctx.outbox` 里最近失败 / 未完成条目（按 `updatedAt` 倒序，最多看 20 条）：
   - 任一条 `failed` → `send.outbox_failed`（`fail`，high），证据含 `lastError`、`attemptCount`。
2. 从 `ctx.traces` 按 stage 聚合最近一次发送（优先最近的 `outbox.attempt`）：
   - `cloud.insert` 为 `error` → `send.cloud_insert_failed`
   - `mqtt.publish` 为 `error` 且 path 为 `remote` → `send.mqtt_publish_failed`（local_fast 上 MQTT 失败是 best-effort，只 `warn`）
   - `local.ingest` 为 `error` → `send.local_ingest_failed`
   - `runtime.ensure` / `runtime.start` 为 `error` → `send.runtime_ensure_failed`
3. 投递成功（outbox `delivered` 或 trace `outbox.attempt` ok）但 runtime 未 ACTIVE → `agent.runtime_inactive`
4. runtime ACTIVE 且 traces / runtimeState 有 turn error → `agent.model_provider_error` 或 `agent.turn_timeout`（看 error 文本是否含 timeout / rate limit）
5. 投递成功、runtime ACTIVE、无 turn 事件 → `send.delivered_no_turn`（`warn`，low）：「消息已送达，尚未观察到 agent turn；可能仍在跑或模型无响应」
6. 以上都没有问题 → `send.path_ok`

没有 outbox 条目且没有 send traces → 不产 send finding（用户没发过消息，不是故障）。

### 5.3 Agent 实时通道（`symptom: realtime`）

同时看 Desktop、daemon、broker probe、SSE：

| 条件 | code | status |
|------|------|--------|
| probe 鉴权失败（`BadUserNamePassword` / `NotAuthorized` / 401）或 access token 过期 | `realtime.mqtt_auth_failed` | fail |
| probe 失败且非鉴权 | `realtime.mqtt_network_failed` | fail |
| Desktop 已连接、daemon `mqtt_connected === false` | `realtime.mqtt_daemon_only` 的对称：`realtime.mqtt_desktop_only` | warn |
| daemon 已连接、Desktop 未连接 | `realtime.mqtt_daemon_only` | warn |
| Cloud 可达 + MQTT 不可用 + SSE 在线 | `realtime.sse_fallback` | warn（升级现有 `livePathHint`） |
| Desktop 已连接但订阅数为 0 | `realtime.topic_empty` | warn |
| Desktop 与 daemon 均连接，probe ok 或未做 probe | `realtime.ok` | ok |

`nextAction`：鉴权失败 → 重新登录；网络失败 → 检查 WSS/代理/防火墙；双端不一致 → 看 daemon MQTT；SSE fallback → 本机流式可能正常，跨设备同步失败。

### 5.4 登录 / 团队同步（`symptom: auth_sync`）

从现有 checks 映射，不新探针：

- 无会话或 token 过期 → `auth.session_invalid`
- daemon `cloud_auth.status === expired` → `auth.daemon_cloud_expired`
- team link 不存在或不可访问 → `sync.team_link_broken`

现有 `DiagnosticCheck.resetTrigger` 逻辑不动；orchestrator 不负责建议 `amuxd clear`。

---

## 6. 模块划分

```
packages/app/src/lib/diagnostics/
  types.ts              # TraceEvent / Finding / Context / cause codes
  trace-buffer.ts       # recordTrace, listTraces, clearTraceBuffer, MAX=800
  session-flow-adapter.ts # map sessionFlowLog → TraceEvent（可单测）
  orchestrator.ts       # diagnose(ctx) + 四条流
  collect-context.ts    # 从已有 report 零件 + store + ring 组 DiagnosticContext
```

`session-flow-log.ts`：在现有 `console[level]` 之后调用 adapter。现有测试继续断言 console 行为；新增测试断言有 `messageId` 时写入 ring。

`diagnostic-report.ts`：`collectDiagnosticReport` 末尾：

1. 组 `DiagnosticContext`（含 `fetchLocalDaemonCatalog`、outbox `Object.values(byId)`、`listTraces()`）
2. `findings = diagnose(ctx)`
3. 报告增加 `schemaVersion: 2`、`findings`、`traces`

采集 catalog 失败当作 `catalog: { status: 'unknown' }`，不得把整个报告打失败。

`DiagnosticsSection.tsx`：**不改。**

发送链路文件（`outbox-sender.ts`、`outbox-store.ts`、`ensure-agent-runtime.ts`）原则上不改调用签名；只在 D3 列出的终态若现有 log 缺 `messageId` 时补 payload。禁止顺手重构发送路径。

---

## 7. 脱敏与隐私

沿用 `mqtt-diagnostics` / `diag-redact`：

- trace `detail` 不得含消息正文、access token、MQTT password、provider key
- `sessionFlowLog` 已有 `summarizeText`；adapter 只拷贝 id、error name/message、attempt、path
- 导出 zip 已声明「已脱敏、不自动上传」——findings 同样适用

---

## 8. 测试

现有测试保持绿：`diagnostic-report.test.ts`、`session-flow-log.test.ts`、`local-daemon-model-catalog.test.ts`。

新增（Vitest，纯函数，不启 Tauri）：

| 文件 | 必须覆盖 |
|------|----------|
| `diagnostics/__tests__/trace-buffer.test.ts` | 超过 800 丢最旧；按 `sessionId` / `traceId` 过滤 |
| `diagnostics/__tests__/session-flow-adapter.test.ts` | `.ok` / `.failed` / `.begin` 映射；无 id 的 log 不入 ring |
| `diagnostics/__tests__/orchestrator-model.test.ts` | empty ≠ fail；probe_error → `backend_probe_failed`；daemon down → unreachable |
| `diagnostics/__tests__/orchestrator-send.test.ts` | outbox failed；remote MQTT fail → fail；local_fast MQTT fail → warn；delivered + 无 turn → `delivered_no_turn` |
| `diagnostics/__tests__/orchestrator-realtime.test.ts` | 鉴权 vs 网络；SSE fallback；Desktop/daemon 不一致 |
| `lib/__tests__/diagnostic-report.test.ts` | `schemaVersion === 2`；`findings`/`traces` 存在 |

不在这一期加 E2E。

---

## 9. 明确不做

- 失败气泡打开 timeline
- daemon 新增诊断 endpoint 或 turn 事件上报
- 持久化 trace / 上传到 Cloud
- Expo / iOS 客户端（仅 Desktop 一键诊断继续 Desktop-only）
- 把 `DiagnosticCheck` 删掉或改现有重置 daemon 卡片

---

## 10. 落地顺序（实现时）

1. types + trace-buffer + adapter + 单测
2. `sessionFlowLog` 接入 adapter
3. orchestrator 四条流 + 单测
4. `collectDiagnosticReport` 组 context、写入 findings/traces、升 schemaVersion
5. 补 `messageId` 缺口（若有），跑现有 diagnostic / outbox / catalog 测试

## 11. Phase 3 UI（已落地）

设置页诊断结果改为四个 tab：模型 / 消息回复 / 实时通道 / 全部检查。前三个顶部是结论卡（worst finding），消息回复 tab 另有横向 stage strip + timeline。`auth_sync` 失败以横幅挂在 tab 上方。

会话头「诊断此会话」写入 `focusSessionId`，打开诊断页并自动跑一次报告，消息回复 tab 按该 `sessionId` 过滤 traces。

## 12. Phase 4 修复动作（已落地）

结论卡和 `auth_sync` 横幅按 cause code 给出修复按钮。映射在 `remediationsForFinding()`：

| 动作 | 典型 cause |
|------|------------|
| 重新登录 | `auth.session_invalid`、`realtime.mqtt_auth_failed` |
| 重连 MQTT | MQTT 网络 / Desktop-only / daemon-only / SSE fallback / topic 空 / `send.mqtt_publish_failed` |
| 重置 daemon | daemon 不可达、云认证过期、runtime / ingest 失败（确认后走现有 `forceReset` + onboarding） |
| 重新连接 Provider / 重新选择模型 | provider 未配置、探测失败、团队网关、turn timeout |
| 重新诊断 | catalog unknown、cloud insert / outbox 失败、`send.delivered_no_turn` |
| 导出诊断包 | 任何 fail/warn finding；zip 文件名带第一个 cause code |

现有 `DaemonResetRemediationCard`（check `resetTrigger`）保留，与 finding 上的「重置 daemon」是两条入口。
