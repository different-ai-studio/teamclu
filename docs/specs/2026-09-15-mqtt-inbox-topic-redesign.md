# MQTT Topic 与消息链路重构（Inbox 化）

- **Date**: 2026-09-15
- **Status**: ACTIVE — §7 轨迹（Phase 2）已于 2026-09-16 落地；Phase 1 与 Phase 3 的
  实施计划与任务拆分见 `docs/specs/2026-09-21-agent-inbox-implementation-plan.md`。
  §12 的待决事项已在 2026-09-21 逐条结案。本文 §1–§10 为 2026-09-15 的现状分析与
  目标设计，除标注处外未改动（`services/fc/src/lib/turn-trace.ts` 等处按 §编号引用）
- **Scope**: `services/fc/`（扇出、inbox、轨迹接口）、`apps/daemon/`（inbox 订阅、轨迹上传、`FetchTurnEvents`）、`packages/app/`、`apps/ios/`、`apps/expo/`、`services/supabase/migrations/`（ACL、inbox 序号、索引）、`deploy/self-host/emqx/`
- **Non-scope**: 更换 broker 或改用 IM 平台；NATS 适配；会话级 broker 授权（EMQX HTTP authz，另立项）；端到端加密
- **Related**: `docs/architecture/knowledge-sync-push-notify.md`（ACL 烘进 JWT 的机制）、`docs/features/03-session-collaboration-realtime.md`（§38 过程/结果二分法）、`docs/adr/0003-acp-commands-fold-into-rpc-channel.md`、`docs/debug/mqtt-realtime-channel-resume-recovery-plan.md`

---

## 0. 一句话

**消息只有一条写入路径（先落 FC），实时投递由 FC 统一扇出到每个接收者的 inbox；`session/<sid>` 下的 topic 只承载 agent 的过程事件，由 daemon 发布、daemon 不订阅；tool call 等中间数据按「每轮摘要进 FC + 完整轨迹进 OSS + 进行中走 RPC 补拉」三层持久化。**

## 1. 背景

这份设计来自四个问题：

1. 一个 daemon 有 1000 个会话，要订阅 1000 个 topic 吗？——**是，而且只增不减**（§2.6）。
2. agent 的中间数据（tool call / tool result）FC 没有（§2.7）。
3. 除了扇出，还有哪些扇入点会出问题（§9）。
4. 一个群里既有本地 agent 又有远端 agent，能实时看到远端 agent 的流式输出吗（§2.8、§6.4）。

---

## 2. 现状

以下均按各端实际收发代码整理，不是按 topic 构造器推断。

### 2.1 Topic 全景

| Topic | 发布方 | 订阅方 | QoS / retain | 载荷 |
|---|---|---|---|---|
| `amux/<team>/<actor>/rpc/req` | 桌面、iOS、Expo、daemon | daemon（自身 agent actor）；桌面 remote-tools（自身 member actor） | 1 / 否 | `RpcRequest` |
| `amux/<team>/<actor>/rpc/res` | daemon（发往 `requester_actor_id`）；桌面 remote-tools | 桌面订 **`amux/<team>/+/rpc/res`**；iOS、daemon 订自身 | 1 / 否 | `RpcResponse` |
| `amux/<team>/<actor>/notify` | daemon（自身；`membership.refresh` 发给请求方） | daemon 自身；iOS 按 agent 订；桌面不订 | 1 / 否 | `Notify` |
| `amux/<team>/<actor>/state` | daemon（retain + LWT） | 桌面订 `+/state`；iOS 按 agent 订 | 1 / **是** | `ActorPresence` |
| `amux/<team>/session/<sid>/live` | daemon（流式：Output/Thinking 为 QoS0，其余 QoS1）；**桌面 outbox、iOS、Expo 直发用户消息** | daemon（跟踪中的会话）；桌面（当前会话 + 流式/待审批会话 + inbox 打开后 1h）；iOS/Expo 详情页 | 0,1 / 否 | `LiveEventEnvelope` |
| `amux/<team>/sync/<resource>` | FC（服务账号） | daemon（可选订阅 `sync/+`） | 1 / 否 | 同步提示 |
| `inbox/<auth_user_id>` | FC `push-dispatch` | 桌面；iOS（订错了 id，见 B1） | 1 / 否 | JSON `{session_id, ts}` |

### 2.2 已废弃但仍残留的 topic

- `amux/<team>/<actor>/runtime/<rid>/commands`：proto 注释写明已被 RPC 取代；daemon 仍通配订阅（`daemon/server.rs` 重连恢复），桌面与 Expo 保留回退发布逻辑。
- `runtime/+/state`、`runtime/+/events`：daemon 中已找不到发布点；Expo 仍订阅；ACL 规则仍列出。
- `amux/<team>/user/<actor>/notify`：只有构造器与 ACL 规则，无任何收发。
- `apps/desktop/src/mqtt/topics.rs` 中的 `rpc-req` / `rpc-res`：连字符旧写法，无调用方。

### 2.3 各端连接参数

| 端 | clientId | clean session | 备注 |
|---|---|---|---|
| daemon | `amuxd-<actor 前 8 位>` | true | keepalive 30s；manual ack + 本地 durable inbox/outbox（上限 4096 条 / 64MB，满则扣住 broker ACK） |
| 桌面（Tauri） | `teamclu-<actor8>-<随机 uuid8>`，**每次连接重新生成** | **false** | keepalive 30s；retained LWT 发到 `amux/<team>/<clientId>/state`，载荷为 JSON |
| 浏览器 | 页面生命周期内稳定 | sessionExpiry 300s | — |
| iOS | — | 未显式设置（CocoaMQTT 默认 clean） | keepalive 90s |
| FC | `fc-publisher-<pid>-<ts>` | true | 单例连接，默认 QoS1 |

EMQX 未改会话参数默认值：`max_inflight = 32`、`max_mqueue_len = 1000`、`session_expiry_interval = 2h`。

### 2.4 ACL 现状

**机制**：GoTrue `amux_access_token_hook` 调 `amux_acl_rules_for(team, actor, type)` 展开规则，末尾追加 `allow sub inbox/<user_id>` 与 `deny all #`，烘进 JWT 的 `acl` claim。EMQX 只配了 JWT 认证、没有 authorization 源。token 带 claim 时是严格白名单；不带 claim 时由 EMQX `no_match` 默认放行。

**仓库配置中 self-host 未启用该 hook**：`deploy/self-host/supabase/docker-compose.yml` 里 `GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_*` 均为注释。按仓库配置，token 不带 `acl` claim，topic 级 ACL 不生效，任何有效用户都能订阅其他团队的 `amux/#` 或任意 `inbox/+`。**线上是否手工开启过需上机解码真实 token 确认（Q4）。**

**规则表与实际流量不一致**（若 ACL 真生效，下列操作都会被拒）：

- daemon（agent 身份）把自身 `rpc/res` 作为必需订阅，规则里没有 → 订阅被拒会触发连接重建循环。
- 桌面 / Expo 发布 `session/+/live`，member 无此发布权 → 被静默丢弃。
- iOS 订阅 `inbox/<memberActorID>`、`<agent>/notify`，均不在白名单。
- daemon 向请求方发 `membership.refresh`，agent 只能发自身 notify。

即使修正规则，粒度也只到团队：任何成员都能订全团队的 `session/+/live` 与 `+/rpc/res`。

### 2.5 发消息链路现状

| 场景 | 顺序 | 问题 |
|---|---|---|
| 桌面，只 @ 本机 agent（`isLocalOnlyAgentMention`） | 本机 HTTP ingest → MQTT live（best-effort）→ FC 写入（**best-effort**） | FC 写入失败时只有本机 agent 收到 |
| 桌面，其余情况（`attemptRemotePath`） | FC 写入（await）→ MQTT live → 非阻塞 RPC 叫醒远端 runtime | — |
| iOS | 默认先发 MQTT 后落库；`persistFirst` 只在新会话 / outbox 路径开启 | 发布成功不等于已落库 |
| daemon 回复 | TurnAggregator 产出思考 / tool call / tool result / 中途回复 / 最终回复 → 全部发 live + 写本地 TOML；**只有每轮最终 AgentReply 写 FC**（`TurnAggregator::cloud_persistent`） | 中间数据云端缺失 |
| FC 扇出 | `insertMessage` 后 fire-and-forget `dispatchPush`：幂等 claim → `list_session_push_targets`（仅 member、排除发送者、排除 muted）→ APNs + `inbox/<uid>` | inbox 与推送耦合 |

### 2.6 daemon 的会话订阅

- **何时订阅**（`SessionManager::ensure_session_live_subscription`）：创建会话；从云端拉到会话且自己是参与者；StartRuntime（包括 dedup 命中）。
- **何时退订**：只有 RemoveParticipant（`refresh_membership_subscriptions`）。runtime 空闲回收不退订 → **进程生命周期内只增不减**。
- **重启**：会话缓存只在内存（`session_store.rs` 无落盘索引），重启清零；之后要靠客户端调 `ensureAgentRuntimesForSession` 触发 StartRuntime 才会重新订阅。桌面的调用是 `void` 不等待，与消息发布存在竞态，首条消息靠 StartRuntime 内的云端 catchup 兜底。
- **重连**：supervisor 逐 topic 重发 SUBSCRIBE；随后 `resubscribe_tracked_live_sessions` 清空集合再串行重订一遍（逐个等 SUBACK）。1000 个会话约 2000 个 SUBSCRIBE 包、1000 次串行往返。token 1h 过期、到期前 5 分钟主动重建连接 → 至少每小时发生一次。
- **自发回送**：daemon 用 MQTT 3.1.1，无 No Local；自己发到 live 的每条流式增量都被 broker 回送给自己（loopback gate 只能收到后丢弃）。

**根因**：`session/<sid>/live` 同时承担「给观看者推流」和「给 agent 投递消息」。member 有 `inbox/<uid>` 负责发现、按需订 live；agent 没有 inbox，只能对所有参与的会话常驻订阅。

### 2.7 中间数据的存放

| 位置 | 内容 | 谁能读 |
|---|---|---|
| daemon 本地 TOML（`teamclu/message_store.rs`）+ pi transcript（`/v1/pi/transcripts/:session_id`） | 完整：思考、tool call、tool result、中途回复 | 本机桌面（HTTP）；iOS（RPC `FetchSessionMessages`，daemon 离线则拿不到） |
| `session/<sid>/live` | 实时经过，不保留 | 当时在线的订阅者 |
| 桌面 local_cache（`handle-live-message.ts` 写入） | 该设备**自己在线时收到的**部分 | 仅该设备 |
| FC `amux.messages` | 每轮一条最终 AgentReply；metadata 平时为空 | 所有人 |

后果：别的成员 / 新设备 / 重装后看不到 agent 做过什么；daemon 离线时 iOS 拿不到 tool 历史；中途进入正在进行的 turn 看不到前半段（`request_recent_session_events` 为空实现）；daemon 换机即永久丢失；多 agent 会话的 tool 历史散落在各 daemon 机器上。

### 2.8 混合群（本地 + 远端 agent）的观看现状

**能实时看到远端 agent 的流式输出**：

```
远端 agent（daemon B，另一台机器）
  └─ MQTT session/<sid>/live（增量 QoS0，tool/状态 QoS1）
       └─ EMQX ──► 桌面（当前会话必在订阅集合）
                     └─ 按 (sessionId, actorId) 各建一个流式条目

本机 agent（daemon A）
  ├─ 本机 SSE /v1/live/events（loopback，通常先到）
  └─ 同时发 MQTT ──► 桌面按 event_id 去重
```

- 当前选中的会话一定在订阅集合（`MqttLiveWiring.tsx` `mergeSessionLiveInterestIds`），打开会话时 `SessionChatColumn` 也会确保订阅。
- 流式条目 key 为 `(sessionId, actorId)`，actorId 取自事件（`handle-acp-event.ts`），不区分本地 / 远端。
- 本机 SSE 只 tee 本机 daemon 的事件，远端 agent 只能走 broker。

**体验差异**：本地延迟接近 0、远端多两段公网 RTT；远端增量 QoS0 可丢，结束时由 `agent-reply-transcript.ts` 的唯一 reconcile 点纠正；broker 不可用时本地照常、远端完全不显示（易误判为 agent 挂了）；**中途进入时桌面没有向远端 daemon 补拉当前 turn 的路径**（iOS 有 `replayStreamingTurnsAfterReconnect`）。

---

## 3. 问题清单

### 3.1 已确认缺陷（可独立修复，见 Phase 0）

| # | 缺陷 | 位置 | 影响 |
|---|---|---|---|
| B1 | iOS 订 `inbox/<memberActorID>`，FC 发往 `inbox/<auth user id>`，两个 UUID 不同 | `SessionListViewModel.startInboxSubscription`、`ContentView` 传入 `memberActorID` | iOS 红点 ping 永远收不到 |
| B2 | 客户端处理 `type:"read"`，但 FC `markSessionViewed` 不发布 | `inbox-handler.ts`、`supabase-repo.ts` | 跨设备已读不同步 |
| B3 | 桌面 `clean=false` + 每次随机 clientId + retained JSON LWT | `apps/desktop/src/mqtt/client.rs`、`MqttLiveWiring.tsx` | broker 堆积 2h 僵尸会话；每次异常断线在 `+/state` 下留一条永久 retained 垃圾，订阅方按 protobuf 解码失败 |
| B4 | 本机快路径 FC 写入为 best-effort | `outbox-sender.ts attemptLocalFastPath` | 写入失败时其他人永远看不到 |
| B5 | 桌面订 `amux/<team>/+/rpc/res` | `teamclu-rpc.ts` | 收到全团队 RPC 响应（带宽 + 隐私） |
| B6 | ACL hook 未启用（按仓库配置）+ 规则表与流量不符 | §2.4 | 无 topic 级隔离 |
| B7 | inbox 载荷无 `team_id`；发送者其他设备收不到 | `push-dispatch.ts` | 跨团队 ping 触发无效列表重拉；多设备列表不同步 |

### 3.2 结构性问题

- **S1** agent 没有 inbox，只能按会话订 live：O(会话数) 订阅、重连成本、自发回送、重启空窗（§2.6）。
- **S2** inbox 挂在推送流水线上：只有 `insertMessage` 触发；`kind=system` 跳过；与 APNs 共用幂等 claim；FC 未配 MQTT 时静默不发。
- **S3** 中间数据云端缺失（§2.7）。
- **S4** 命名空间混用：第 3 段混用 actor id 与保留字（`session` / `sync` / `user`），`inbox/` 在 `amux/` 之外。例：新增名为 `state` 的 sync 资源，`amux/<team>/sync/state` 会被 `amux/<team>/+/state` 匹配并当作在线状态解码。
- **S5** topic 构造散落：Rust `teamclu-types`、Swift `MQTTTopics`、FC `mqtt-topics.ts`（只有 sync），外加 TS / Expo 十余处手写模板字符串。B1 就是这种漂移的直接后果。
- **S6** daemon 的 retained presence 带 `live_sessions`，单条可达约 7KB，每个 `+/state` 订阅者每次连接都全量拉取。

---

## 4. 设计原则

1. **一条写入路径**：消息先落 FC；live、inbox、APNs 的实时投递全部由 FC 扇出。客户端不再发布 `session/*`。本机直投只是加速，不能替代写入。
2. **会话 topic 只放过程**：`session/<sid>/*` 承载 agent 过程事件和 FC 发的持久消息通知；daemon 只发不订。
3. **每个接收者一个 inbox**：agent inbox 带完整消息；member inbox 是轻量信号。
4. **MQTT 是快路径，游标补拉是可靠路径**：任何 MQTT 投递都允许丢；接收方靠连续序号发现断档并补拉；全链路以 `message_id` 幂等。
5. **数据三分类**（扩展 `03-session-collaboration-realtime.md` §38 的过程 / 结果二分）：

| 类 | 例 | 传输 | 持久化 |
|---|---|---|---|
| 过程 | 文字增量、思考增量、在线状态 | QoS0，可丢 | 不持久化 |
| 结果 | 消息、参与者、会话 | 可靠写入 FC | Postgres |
| **轨迹** | tool call、tool result、本轮中途回复 | 进行中走会话 topic（QoS1）+ RPC 补拉 | 每轮摘要进 FC，完整内容进 OSS |

轨迹在传输上像过程（随流走），在语义上像结果（用户要回看 agent 改了哪些文件、跑了什么命令）。直接当普通消息写进 FC 不可行：每条都会触发 APNs 与 inbox ping、污染未读与列表预览、单个 tool result 可达数 MB、一轮可有几十个 tool call。

---

## 5. 目标 Topic 设计

### 5.1 Topic 表

| Topic | 发布方 | 订阅方 | QoS | 内容 |
|---|---|---|---|---|
| `amux/<team>/<agent>/inbox` | FC | 该 agent 所在 daemon | 1 | `AgentInboxEvent`（§5.3） |
| `inbox/<user_id>` | FC | 该用户的所有设备 | 1 | `MemberInboxPing`（§5.3） |
| `amux/<team>/session/<sid>/events` | daemon（轨迹、turn 生命周期、权限请求）；FC（`message.created`、参与者变更） | 打开该会话的客户端 | 1 | `LiveEventEnvelope` |
| `amux/<team>/session/<sid>/stream` | daemon | 打开该会话且在前台的客户端 | 0 | 文字 / 思考增量 |
| `amux/<team>/<actor>/rpc/req` | 客户端、daemon | 目标 actor | 1 | 不变 |
| `amux/<team>/<actor>/rpc/res` | daemon、客户端 | **只有请求方自身** | 1 | 不变 |
| `amux/<team>/<actor>/state` | daemon（retain + LWT） | 客户端 | 1 | 不变；客户端不再设置 LWT |
| `amux/<team>/sync/<resource>` | FC | daemon | 1 | 不变 |

命名取舍：

- **member inbox 保持用户级、不分团队**：一个订阅覆盖用户所在所有团队（手机角标需要）；载荷带 `team_id`，客户端对非当前团队只更新角标。
- **agent inbox 放在团队命名空间**：agent 身份本来就属于团队，daemon 连接也是按团队的。
- **拆分 events / stream**：多 agent 会话中流量相加（每个 agent 约 20 条/秒），手机在后台或列表页只订 `events`。
- 迁移期保留旧的 `session/<sid>/live`（§11）。

### 5.2 删除清单

`runtime/<rid>/commands`、`runtime/+/state`、`runtime/+/events`、`user/<actor>/notify`、`<actor>/notify`（并入 inbox）、桌面 `topics.rs` 的 `rpc-req` / `rpc-res`、`session/<sid>/live`（Phase 4）。

### 5.3 载荷草案

```proto
// amux/<team>/<agent>/inbox
message AgentInboxEvent {
  uint64 inbox_seq = 1;          // 该 agent 连续递增，见 §8.2
  string team_id = 2;
  string session_id = 3;
  oneof event {
    MessageCreated message_created = 10;
    ParticipantChanged participant_changed = 11;
    SessionArchived session_archived = 12;
  }
}

message MessageCreated {
  Message message = 1;           // content、mentions、attachment_urls、turn_id
  bool mentioned = 2;            // FC 根据 metadata 里的 mentions 计算
}
```

```jsonc
// inbox/<user_id>
{
  "v": 2,
  "team_id": "…",
  "session_id": "…",
  "type": "message" | "read" | "membership",
  "message_id": "…",
  "sender_actor_id": "…",
  "ts": 1757900000000
}
```

会话 topic 上的每个过程 / 轨迹事件都带 `turn_id` + `turn_seq`（本轮内递增），客户端据此发现断档。

### 5.4 ACL 目标规则

前置：确认 self-host 与 belayo 的 hook 实际状态（Q4），并让规则表先匹配现有流量，再收紧。

| 身份 | pub | sub |
|---|---|---|
| member | `amux/<team>/+/rpc/req`、`amux/<team>/+/rpc/res`（remote-tools 应答） | `amux/<team>/<self>/rpc/req`、`amux/<team>/<self>/rpc/res`、`inbox/<user_id>`、`amux/<team>/session/+/events`、`amux/<team>/session/+/stream`、`amux/<team>/+/state`、`amux/<team>/sync/+` |
| agent | `amux/<team>/session/+/events`、`amux/<team>/session/+/stream`、`amux/<team>/<self>/state`、`amux/<team>/+/rpc/req`、`amux/<team>/+/rpc/res` | `amux/<team>/<self>/inbox`、`amux/<team>/<self>/rpc/req`、`amux/<team>/<self>/rpc/res`、`amux/<team>/sync/+` |
| FC | 服务账号，不受 claim 约束 | — |

member 不再需要 pub 会话 topic；agent 不再需要 sub 会话 topic。「只能订阅自己参与的会话」无法用签发时固定的 claim 表达，需要 EMQX HTTP authz，另立项。

---

## 6. 链路

### 6.1 人发消息

```
客户端 outbox
 ① POST /v1/sessions/:sid/messages   {id 客户端生成, content, mentions, attachments}
    └ 本机有 agent 时：同时 HTTP ingest 给本机 daemon（加速，不替代 ①）

FC
 ② INSERT messages；同一事务内为每个 agent 参与者（排除发送者）写 actor_inbox_items、分配 inbox_seq（§8.2）
    id 冲突 = 客户端重试，按幂等返回
 ③ 提交后异步扇出，不阻塞 HTTP 响应：
    a. session/<sid>/events    message.created                → 正在看的人
    b. <agent>/inbox           每个 agent 参与者一份（完整消息）→ daemon
    c. inbox/<uid>             每个 member 参与者               → 含发送者其他设备（发送设备按 message_id 忽略）
    d. APNs                    沿用免打扰、前台过滤

daemon
 ④ 收 inbox → inbox_seq 断档则补拉 → 按 message_id 去重（本机已 ingest 的直接丢弃）
    → route_session_message：被 @ 进 prompt，其余进 pending_silent
 ⑤ 没有 runtime 时自行 resume / StartRuntime，不依赖客户端 ensure
```

要点：

- 客户端 outbox 必须一直重试到 ① 成功（修 B4）；iOS 默认改为先落库。
- 远端路径现在就是先 await FC 再发 MQTT，新链路只多一跳 FC → broker（同机 / 同集群，毫秒级）；iOS 发送体感多一次 HTTP RTT，这是用延迟换一致性。

### 6.2 agent 回复

```
daemon：turn 进行中
 ① session/<sid>/stream：文字增量、思考增量（QoS0）
    session/<sid>/events：turn.started、tool.call、tool.result 摘要、permission.request（QoS1）
    每条带 turn_id + turn_seq

daemon：turn 结束（Active→Idle）
 ② 本轮轨迹打包 jsonl.gz → 向 FC 申请 presigned PUT → 直传 OSS
 ③ POST /v1/sessions/:sid/messages
    kind=agent_reply, metadata={ tools:[摘要], trace:{key,size,sha256,status} }
    上传失败：先写 trace.status=pending，daemon durable outbox 重传后 PATCH
 ④ session/<sid>/events：turn.ended {turn_id, message_id}

FC
 ⑤ 与 §6.1 相同的扇出：
    events 上 message.created（客户端把流式换成最终内容）、member inbox、
    其他 agent 的 inbox（多 agent 会话中 agent 之间可见，作为上下文）、APNs

客户端
 ⑥ 展开 tool 卡片 → GET /v1/sessions/:sid/turns/:turn_id/trace → 签名 URL → 下载
```

### 6.3 已读与成员变更

- `markSessionViewed` 成功后，FC 发 `inbox/<uid>` `type:"read"`（修 B2）。
- 参与者增删后，FC 向受影响 agent 的 inbox 发 `participant_changed`，并在会话 `events` 上广播；取代 daemon 的 `membership.refresh` notify。

### 6.4 观看者：本地 + 远端 agent 混合群

| 阶段 | 行为 |
|---|---|
| 打开会话 | 订 `events` + `stream`；本机 agent 事件仍经本机 SSE 并入，按 `event_id` 去重 |
| 中途进入 | 从 `events` 拿到进行中 turn 的 `turn_id` / `turn_seq`，对每个进行中的 agent 发 `FetchTurnEvents` 补齐（rpc/req 跨机器天然可达） |
| turn 结束 | FC 的 `message.created` 替换流式内容；tool 卡片从 OSS 懒加载 → **远端 agent 的 tool 历史对所有人可见** |
| broker 不可用 | 本地仍流式、远端不可见；UI 必须区分「broker 未连接」与「agent 离线」 |

### 6.5 断线重连

- **daemon**：连上 → 按本地 inbox 游标补拉（§8.3）→ 订阅 inbox（1 个 topic）→ 按 `message_id` 去重。
- **客户端**：重连 → 刷新会话列表（沿用现状）→ 对打开的会话发 `FetchTurnEvents`。
- 所有端重连加随机抖动，避免同一时刻集中换 token、拉 bootstrap。

---

## 7. 轨迹持久化

### 7.1 每轮摘要（FC）

最终 AgentReply 的 `metadata` 新增字段。`turn_aggregator.rs` 的 metadata 契约允许新增 key、禁止删除，属于兼容变更。

```json
{
  "tools": [
    { "tool_id": "…", "name": "…", "description": "…", "success": true, "duration_ms": 412 }
  ],
  "trace": {
    "key": "turns/<team>/<sid>/<turn_id>.jsonl.gz",
    "size": 18234,
    "sha256": "…",
    "status": "uploaded"
  }
}
```

- `trace.status ∈ uploaded | pending | failed`。
- 摘要总大小设上限（起步 32KB），超出时截断 `tools` 并标记 `tools_truncated: true`。
- 每轮仍是一行，推送与未读逻辑不变。

### 7.2 完整轨迹（OSS）— 已拍板

- **对象**：`turns/<team>/<session>/<turn_id>.jsonl.gz`，一行一个事件（thinking / tool_call / tool_result / 中途回复），带 `turn_seq`。
- **截断**：单个 tool result 超过阈值（起步 256KB）时保留头尾、原始大小与 sha256。
- **上传**：turn 结束 → daemon 向 FC 申请 presigned PUT（复用 knowledge 同步 `sync-handlers.ts` 的 `createUploadUrl` 模式，daemon 不持有 OSS 密钥）→ 直传 OSS → 写最终 AgentReply。
- **失败**：先写 `trace.status=pending`，daemon durable outbox 重传成功后 `PATCH /v1/messages/:id`。
- **读取**：`GET /v1/sessions/:sid/turns/:turn_id/trace` → 按会话参与者鉴权 → 返回签名 GET URL。
- **客户端**：展开 tool 卡片时懒加载；**不合并进 `message.content`**（CLAUDE.md 流式单一来源原则）。
- **安全叙事**：与 knowledge 相同，服务端明文存储；对外不承诺加密。
- **保留期**：待定（Q1）。

### 7.3 进行中：`FetchTurnEvents` RPC

```proto
message FetchTurnEventsRequest {
  string session_id = 1;
  string turn_id = 2;
  uint64 after_turn_seq = 3;
  uint32 page_size = 4;
}

message TurnEventsPage {
  repeated LiveEventEnvelope events = 1;
  bool has_more = 2;
  uint64 next_turn_seq = 3;
}
```

- daemon 从本地 TOML / 内存回放；必须分页（桌面 MQTT 包上限 4MB）。
- 取代空实现 `SessionManager::request_recent_session_events`。
- 目标 daemon 离线时该轮不会再有新事件，结束后以 FC 摘要 + OSS 轨迹为准。

---

## 8. 可靠性

### 8.1 投递语义

| 路径 | 语义 | 去重键 |
|---|---|---|
| MQTT（QoS1） | 至少一次，**允许丢**（broker 队列满、FC 发布前崩溃、断线） | `message_id`（消息）、`(turn_id, turn_seq)`（轨迹事件） |
| 游标补拉 | 精确 | 同上 |

### 8.2 每个接收者的连续序号

全局单调的 `server_seq` 只能支持「拉取游标之后的消息」，接收者无法据此发现断档，因为自己收到的序号本来就不连续。因此 agent inbox 使用**每个接收者连续**的序号：

- `amux.actor_inbox_cursor(actor_id pk, last_seq bigint)`
- `amux.actor_inbox_items(actor_id, seq, message_id, kind, created_at)`，主键 `(actor_id, seq)`
- **与消息写入同一事务**分配序号并写 items（倾向 `after insert on amux.messages` 触发器，覆盖所有写入路径，Q9）。这样「写入成功、MQTT 发布前崩溃」时补拉仍能拿到。
- daemon 收到 `inbox_seq` 跳变立即补拉缺口。
- 代价：每条消息对每个 agent 接收者一次行锁。agent 收到的主要是人类消息与其他 agent 的最终回复，频率低，可接受。
- member inbox 不做连续序号：只驱动角标，前台时刷新列表即可。

### 8.3 补拉接口

`GET /v1/actors/me/inbox?after_seq=<n>&limit=500`

- 按 `(actor_id, seq)` 索引读 `actor_inbox_items` 并连 `messages` 返回。
- 必须分页。FC 会话列表曾因 plpgsql 通用计划悬崖撞过 8s 超时，这里要用简单 keyset 查询。

### 8.4 失败窗口

| 窗口 | 结果 | 兜底 |
|---|---|---|
| FC 写入成功、MQTT 发布前崩溃 | 实时投递丢失 | items 已随事务写入 → 补拉 |
| broker 队列满丢弃 | 实时投递丢失 | `inbox_seq` 跳变 → 补拉 |
| daemon 本地 inbox 满 | 扣 ACK → broker 积压 → 丢弃 | 同上 |
| OSS 上传失败 | 轨迹缺失 | `trace.status=pending` + 重传 |
| 客户端中途进入 | 本轮前半段缺失 | `FetchTurnEvents` |

---

## 9. 扇入分析

| # | 扇入 | 风险 | 严重度 |
|---|---|---|---|
| 1 | 1000 个会话 → 1 个 agent inbox → daemon 主循环 | broker 丢消息、队头阻塞、乱序 | 高 |
| 2 | 所有客户端、daemon、网关、cron → FC 写入并扇出 | 每条消息多次查询与发布，并发无上限 | 中 |
| 3 | 同时重连（broker 重启、网络抖动） | token、bootstrap、列表刷新、补拉同时涌入 | 中 |
| 4 | 用户所有团队 → `inbox/<uid>` → 手机 | ping 风暴、列表反复重拉 | 中 |
| 5 | 多个 agent → 同一会话 topic → 观看者 | 3 个 agent 约 60 条/秒推给每个观看者 | 中 |
| 6 | agent A 的回复 → agent B 的 inbox | agent 之间互相回复死循环 | 现在没有，需守住 |
| 7 | 同一成员多台设备 → 同一权限请求的应答 | 两台设备同时点「允许」 | 待核实（Q5） |
| 8 | 多个 daemon turn 结束上传轨迹 | 直传 OSS，FC 只签发 | 非瓶颈 |

**1. agent inbox → daemon**

- broker 侧：每连接 `max_inflight=32`、`max_mqueue_len=1000`。daemon manual ack，本地 durable inbox 满（4096 条 / 64MB）时扣住 ACK → inflight 卡满 → 队列满后 EMQX 丢弃消息。该上限按连接计算，现状也受限，但 inbox 更集中且带完整消息体。
- daemon 侧：主循环逐条接收、串行 await `ingest_session_live` → `route_session_message`，其中还 await 外部网关推送与历史 runtime 恢复（拉起进程，秒级）。**一个会话冷启动会卡住所有会话。**
- 顺序：FC 多实例发布、QoS1 重投都会乱序，以 `inbox_seq` 为准，不以到达顺序为准。
- 对策：主循环只做「落盘 + ACK」，按 `session_id` 分发到每会话队列；冷启动与网关推送移出主循环；`inbox_seq` 断档补拉；可选调大 `mqtt.max_inflight`（只加缓冲，不替代补拉，Q7）。

**2. FC 写入与扇出**

- 每条消息：`push_idempotency_claim` + `list_session_push_targets` 两次 DB 调用，1 条会话 topic + N 条 agent inbox + M 条 member inbox + APNs。20 人会话约二十多次发布。
- FC MQTT 连接是单例；扇出为 fire-and-forget Promise，并发无上限。
- 对策：`fanoutMessage` 放进有界并发队列；批量查询推送目标。tool call 不经 FC——这正是把轨迹留在会话 topic + OSS 的收益。

**3. 重连风暴**

- 客户端重连后只对当前会话里参与的 agent 做 ensure 且有节流（`use-reensure-runtimes-on-mqtt-reconnect.ts`），新链路下可删除。
- daemon 补拉分页 + 索引（§8.3）；全端重连随机抖动。

**4. `inbox/<uid>` 跨团队**

- FC 按用户做 1s 窗口合批，一次发 `{team_id, sessions:[…]}`；客户端对非当前团队只更新角标。现有 300ms 防抖合并不了跨秒突发。

**5. 多 agent 会话**

- `events` / `stream` 拆分（§5.1）；手机后台与列表页只订 `events`。

**6. agent 之间互投**

- 现状 agent 回复的 mentions 恒为空（`SessionManager` 发布消息时从 metadata 解析 mentions，agent 回复为空列表），对端 daemon 只放进 `pending_silent`，不触发回复。
- 新链路中 FC 从 metadata 计算 `mentioned` 时必须保持该不变量；将来若允许 agent @ agent，需加 `metadata.hop` 跳数上限与每会话限流。

---

## 10. 客户端连接与 topic 构造规范

- **clientId**：每设备稳定（本地持久化），格式 `<kind>-<actor8>-<device8>`，不再每次随机。
- **会话**：客户端使用 clean session（或短 session expiry），不依赖 broker 离线队列。
- **LWT**：客户端不设置 retained LWT；在线状态只由 daemon 发布。
- **topic 构造单一来源**：`crates/teamclu-types/src/mqtt.rs` 为权威；TS（app / Expo / FC）与 Swift 各一份镜像，配同一组固定输入输出的契约测试；业务代码禁止手写 topic 模板字符串，加 guardrail 测试（参照 `no-supabase-import.test.ts`）。

---

## 11. 迁移计划

新旧客户端会长期共存，每个阶段都必须向后兼容。

### Phase 0 — 独立缺陷修复（不依赖新设计）

- B1：iOS inbox 改用 auth user id。
- B2：FC `markSessionViewed` 发布 read ping。
- B3：桌面稳定 clientId + clean session + 去掉 LWT；上机清理 `amux/+/teamclu-*/state` 下的垃圾 retained。
- B5：桌面只订自身 `rpc/res`（先确认桌面发 RPC 的 requester 身份是否只有 member actor）。
- B6：上机确认 hook 状态；先把规则表修到与现有流量一致，不收紧。
- B7：inbox 载荷加 `team_id`、`type`、`message_id`（`v: 2`，旧客户端忽略新字段）。

**验收**：iOS 红点实时出现；跨设备已读同步；`+/state` 下无非 protobuf 的 retained 消息。

### Phase 1 — agent inbox（daemon 双订）

> **2026-09-21 修订**：`actor_inbox_cursor` / `actor_inbox_items` / 写入触发器
> **已取消**（§12 Q9）。断档检测改为比对会话列表已有的 `lastMessageAt` 与 daemon
> 自身游标，在每次 MQTT 连上时增量对账。整个 Phase 1 **不引入新表、新触发器或迁移**。

- FC：`fanoutMessage` 从 `dispatchPush` 拆出，APNs 作为其中一个下游；向每个 agent
  参与者的 `<agent>/inbox` 投**完整消息行**（QoS1）。agent 参与者需直接查
  `session_participants ⨝ actors`——`list_session_push_targets` 里写死了
  `actor_type = 'member'`，agent 被排除在外，不能复用。
- daemon：订阅 inbox，同时保留现有会话 live 订阅，靠现有 `MessageDedup` 按
  `message_id` 去重；主循环按会话分流。
- daemon：MQTT 连上（**含重连**）时做增量对账——拉一次会话列表，只对 `lastMessageAt`
  晚于本地水位线的会话跑 `plan_session`。水位线只在内存，进程重启即回退到全量扫描
  （即现状行为）。这修掉了「`offline_restart` 只在进程启动时跑，重连不对账」这个缺口。
- idea 事件一并改走 inbox，使 daemon 在 Phase 4 可以彻底退订 live。

**兼容**：旧客户端仍直发 live，daemon 仍能收到。
**broker 保持无状态**：`clean_session=true` 不变。投递可靠性由「库是真相 + 消费者持
游标 + 连接时对账」保证，不依赖 broker 代存（2026-09-21 决定）。
**验收**：daemon 重启后不依赖客户端 ensure 即可收到 @；重连后不丢消息；
1000 会话重连只恢复个位数 topic。

### Phase 2 — 轨迹 ✅ 已完成（2026-09-16）

已落地：FC 的 `trace/prepare`、`trace/complete`、`GET .../trace`
（`services/fc/src/lib/turn-trace.ts`）；daemon 的 `runtime/turn_trace.rs` 上传；
iOS 消费端（#1499、#1501）。`messages.metadata.trace` 存
`{key, size, sha256, status}` 指针，轨迹本体在 OSS。

**仍未做**：`FetchTurnEvents` RPC（中途进入时补齐本轮前半段）。它是独立缺口，
不阻塞其他阶段，单独跟进。

### Phase 3 — 单一写入路径 + topic 拆分

- 客户端改为先写 FC、不发会话 topic；iOS 默认 `persistFirst`；本机直投仅做加速。
- FC 在 `events` 上发 `message.created`（迁移期同时发旧 `live`）。
- daemon 过程事件同时发 `live` 与 `events` / `stream`。

**验收**：FC 写入失败场景下不再出现「只有本机 agent 收到」；手机后台只订 `events` 时流量明显下降。

### Phase 4 — 收口（最低版本线之后）

最低版本线依据 `report_client_version` 上报的数据确定。

- daemon 退订 `session/live`，停发旧 `live`。
- 启用并收紧 ACL（§5.4）。
- 删除残留 topic 与相关代码（§5.2）。

---

## 12. 待决事项

2026-09-21 逐条结案。实施细节见
`docs/specs/2026-09-21-agent-inbox-implementation-plan.md`。

| # | 问题 | 结论（2026-09-21） |
|---|---|---|
| Q1 | OSS 轨迹保留期 | 仍待定。Phase 2 已上线且未设清理，需单独跟进 |
| Q2 | agent inbox 投全量消息还是只投 @ | **全量**。保留 `pending_silent` 语义——只投 @ 的话 agent 感知不到会话里其他人说了什么 |
| Q3 | member inbox 用户级还是团队级 | **用户级**，维持现状 |
| Q4 | self-host / belayo 的 access token hook 实际是否生效 | 仍待定，属 Phase 4（ACL 收紧），不阻塞 Phase 1/3 |
| Q5 | 多设备应答同一权限请求，daemon 是否按 `request_id` 幂等 | 仍待核实，与本次范围无关 |
| Q6 | FC（belayo Dokploy）是否多副本 | 仍待确认 |
| Q7 | 是否调大 EMQX `mqtt.max_inflight` | 先观测再定 |
| Q8 | 摘要与单个 tool result 的截断阈值 | Phase 2 已按 daemon 侧 ~9 MiB 未压缩上限落地 |
| Q9 | inbox items 用 DB 触发器还是 FC 内 RPC 事务 | **两者都不用**。取消 `inbox_seq` 与 `actor_inbox_items`，改用 `lastMessageAt` 水位线 + 连接时对账（§11 Phase 1）。理由：断档检测的价值是把 O(会话数) 的扫描降成 O(1)，而这可以用会话列表里现成的字段做到，不必新增表、触发器和迁移——belayo 的迁移是手工执行的，能不加就不加 |

### 12.1 本次一并结案的其他问题（2026-09-21）

| 问题 | 结论 |
|---|---|
| B1 在哪端修 | 改 **iOS**，订 `inbox/<auth user id>`，对齐 FC 已在发布的 topic。FC 不动 |
| idea 事件是否走 inbox | **走**。否则 daemon 无法在 Phase 4 退订 live |
| FC 投递失败是否加重试队列 | **不加**。由 daemon 连接时对账兜住 |
| daemon 是否改用 MQTT 持久会话让 broker 代存 | **不改**。有状态的 broker 会变成第二个真相来源，运维、扩容、队列溢出都是静默风险。`clean_session=true` 维持不变 |
| 是否拆 `events` / `stream` 两个 topic | **本次不拆**，继续用 `/live`。拆分是 QoS 优化而非正确性修复，拆了会让客户端改动翻倍 |
| Phase 3 是否需要多版本迁移梯子 | **不需要**。产品尚未正式发布，可直接切到目标状态；但 self-host 每晚 00:00 才部署、iOS 走 TestFlight，仍有数小时到数天的错位窗口，客户端按 `message_id` 去重是向前兼容的，应尽早发 |

---

## 附录 A：代码索引

| 路径 | 作用 |
|---|---|
| `crates/teamclu-types/src/mqtt.rs` | Rust topic 构造器（权威） |
| `apps/ios/Packages/AMUXCore/Sources/AMUXCore/MQTT/MQTTTopics.swift` | Swift 镜像 |
| `services/fc/src/lib/mqtt-topics.ts` | FC 镜像（只有 sync） |
| `services/fc/src/lib/push-dispatch.ts` | APNs + `inbox/<uid>` 扇出 |
| `services/fc/src/lib/mqtt-client.ts` | FC 单例 MQTT 发布连接 |
| `services/fc/src/lib/supabase-repo.ts` | `insertMessage` 触发 `dispatchPush`；`markSessionViewed` |
| `services/supabase/migrations/20260826100000_inbox_mqtt_acl.sql` | access token hook（inbox 规则 + `deny #`） |
| `services/supabase/migrations/20260827000000_acl_sync_topic.sql` | `amux_acl_rules_for` 规则表 |
| `deploy/self-host/emqx/emqx.conf` | EMQX 监听与 JWT 认证 |
| `deploy/self-host/supabase/docker-compose.yml` | GoTrue hook 配置（注释状态） |
| `apps/daemon/src/teamclu/session_manager.rs` | 会话 live 订阅增减、RPC 会话方法、消息发布与持久化 |
| `apps/daemon/src/daemon/server/messaging.rs` | 入站 `message.created` 路由 |
| `apps/daemon/src/mqtt/supervisor.rs` | 连接、订阅恢复、durable inbox 上限 |
| `apps/daemon/src/mqtt/client.rs` | daemon 连接参数 |
| `apps/daemon/src/teamclu/live.rs` | live 发布与 QoS 选择（`acp_event_guarantee`） |
| `apps/daemon/src/runtime/turn_aggregator.rs` | 轨迹产出、`cloud_persistent`、metadata 契约 |
| `apps/daemon/src/teamclu/message_store.rs` | daemon 本地 TOML 历史 |
| `packages/app/src/components/MqttLiveWiring.tsx` | 桌面 MQTT 接线、clientId、live 兴趣集合 |
| `packages/app/src/services/outbox-sender.ts` | 桌面发送路径选择 |
| `packages/app/src/lib/messages/inbox-handler.ts` | 桌面 inbox 处理 |
| `packages/app/src/lib/daemon/teamclu-rpc.ts` | 桌面 `+/rpc/res` 通配订阅 |
| `packages/app/src/components/mqtt-live-wiring/handle-acp-event.ts` | 按 `(sessionId, actorId)` 建流式条目 |
| `apps/desktop/src/mqtt/client.rs` | 桌面 Tauri 连接参数与 LWT |
| `apps/ios/Packages/AMUXCore/Sources/AMUXCore/ViewModels/SessionListViewModel.swift` | iOS inbox 订阅 |
| `apps/ios/Packages/AMUXCore/Sources/AMUXCore/TeamcluService.swift` | iOS 发消息、`FetchSessionMessages` |

## 附录 B：决策记录

| 日期 | 决策 |
|---|---|
| 2026-09-15 | tool result 完整内容上传 OSS（§7.2） |
