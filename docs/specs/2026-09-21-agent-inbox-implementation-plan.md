# Agent Inbox 实施计划（#1455 Phase 1 + Phase 3）

- **Date**: 2026-09-21
- **Status**: PLANNED — 任务拆分已对齐，未开工
- **设计依据**: `docs/specs/2026-09-15-mqtt-inbox-topic-redesign.md`（§编号沿用该文）
- **Scope**: `services/fc/`（扇出）、`apps/daemon/`（inbox 订阅、连接时对账）、
  `packages/app/`、`apps/ios/`
- **Non-scope**: `inbox_seq` / `actor_inbox_items` / 写入触发器、`FetchTurnEvents`、
  `events` / `stream` topic 拆分、Phase 4 的 ACL 收紧
- **无数据库迁移**

---

## 1. 起因：2026-09-21 的现场

用户从 iOS 在会话里 @ 一个 agent，agent 没有任何反应。同一天早些时候的多条
@ 消息同样无人应答。

服务端取证（self-host）：

| 环节 | 结论 |
|---|---|
| iOS 写入 | ✅ 消息落库，`metadata.mention_actor_ids` 正确 |
| iOS 发布 | ✅ `TeamcluService.sendMessage` 会向 `session/<sid>/live` 发布，且 MQTT 未连接会直接抛错——消息既已落库，说明当时连着 |
| 云端参与者 | ✅ 被 @ 的 agent 在该会话的 `session_participants` 里 |
| daemon 在线 | ✅ EMQX 上 `amuxd-<actor>` 已连接，`actors.last_active_at` 是几分钟前 |
| **daemon 订阅** | ❌ 只订了 **1 个**会话的 live——当天新建的那个；用户 @ 的那个**没订** |

对照：另一个 agent 的 daemon 订了 19 个会话的 live，在它订阅的会话里工作正常。

daemon 的 MQTT 连接参数是 `clean_session=true` / `session_expiry_interval=0`，
**broker 不代存**，发到无人订阅的 topic 上即丢弃。

## 2. 根因：两个洞叠加

### 2.1 订阅面靠"恰好发生过某件事"建立，没有对账

`ensure_session_live_subscription` 的全部触发点（`teamclu/session_manager.rs`
第 314 / 431 / 532 / 712 行，`daemon/server/runtime_lifecycle.rs` 第 530 / 615 行）
都是事件式的：创建会话、启动 runtime、从云端拉到会话。

真正按"我是参与者所以我订"来对账的 `refresh_membership_subscriptions`，全仓库
**唯一**的调用点是 `handle_remove_participant`（`session_manager.rs:605`）——
它只做减法，从不做加法。

重连时的 `resubscribe_tracked_live_sessions`（`daemon/server.rs:1067`）只恢复
**进程内存里已有的那一份**，不会发现新的。

结果：daemon 进程重启后，所有既有会话都是聋的，直到有人碰巧为它启动一次 runtime。

### 2.2 补偿层只在进程启动时跑

`offline_restart` 的逻辑本身是对的——它按参与者游标拉取消息、用
`last_unanswered_mention_idx` 找未应答的 @、起 runtime 补跑。但它只在
`spawn_offline_restart_planning`（`daemon/server.rs:1989` / `2469`）被调用，
也就是**只在进程启动时**。

当天 daemon **进程没有重启**，只是 MQTT 重连——证据是
`resubscribe_tracked_live_sessions` 恢复出来的恰好是那一个会话，说明内存里的
tracked 集合还活着。所以对账没有触发。

**两个洞单独存在都不致命**：订阅漏了但重启会补上；补偿没跑但 live 能收到。
叠加起来，消息就永远消失了。

## 3. 目标状态

```
人发消息 → FC 落库 → FC 扇出
                      ├─ <agent>/inbox        完整消息行（QoS1）→ daemon
                      ├─ session/<sid>/live   message.created    → 在看的客户端
                      ├─ inbox/<uid>          红点 ping           → 该用户各设备
                      └─ APNs                                     （沿用现状）

daemon → session/<sid>/live   流式增量、turn 事件（发布，不订阅）
```

daemon 对 `session/<sid>/live` 的**订阅**降为 0，**发布**不变。客户端仍在前台
打开会话时订阅 live 看流式——这条路一行不改。

可靠性三层，**不依赖 broker 状态**：

| 层 | 覆盖 |
|---|---|
| FC → inbox（QoS1） | 正常投递 |
| 连接时增量对账（新） | 短时断线、重连窗口 |
| `offline_restart` 全量扫描（已存在） | 进程重启、长时间离线 |

## 4. 任务拆分

| # | 范围 | 内容 | 依赖 |
|---|---|---|---|
| **1** | FC | `fanoutMessage` 从 `dispatchPush` 拆出；查 agent 参与者并向 `<agent>/inbox` 投完整消息行（QoS1）；修 B7（`inbox/<uid>` 载荷加 `team_id`）；投递失败必须记日志 | — |
| **2** | daemon | 订阅 inbox → `route_session_message`（复用）；`MessageDedup` 按 `message_id` 去重；**保留** live 订阅走双路；连接时增量对账 | 1 |
| **3** | 客户端 | `message.created` 改按 `message_id` 去重；修 B1（iOS inbox topic） | — 可并行 |
| **4** | FC | `fanoutMessage` 增发 `session/<sid>/live` 上的 `message.created` | 3 |
| **5** | 客户端 | 停止自己 publish；**收口重写** | 4 |
| **6** | daemon | 摘掉 live 订阅**的调用点**（保留 `ensure_session_live_subscription` / `unsubscribe_session_live` 函数本身）；idea 事件改走 inbox | 5 |

**PR 1 + 2 落地即修复第 1 节的故障**，且零客户端改动。PR 3 向前兼容，可立即发布。

### PR-1 · FC 扇出

- `services/fc/src/lib/push-dispatch.ts` → 拆出 `fanoutMessage`，APNs 成为其中一个下游。
- `services/fc/src/lib/supabase-repo.ts:2053`（`insertMessage`）调用点不变，仍在插入后
  异步触发、不阻塞 HTTP 响应。
- **agent 参与者要另外查**：`list_session_push_targets` 里写死
  `a.actor_type = 'member'`，agent 被排除。直接查 `session_participants ⨝ actors`
  即可，FC 用 service role，不受 RLS 限制，**不需要新函数、不需要迁移**。
- 现在 `dispatchPush` 的错误是 `console.error(... swallowed)`。inbox 成为主投递路径后
  不能沿用——至少要记结构化日志，便于事后与对账结果比对。

### PR-2 · daemon 订 inbox + 连接时对账

- 订阅 `amux/<team>/<agent>/inbox`，解码后走现有 `route_session_message`。
- 去重复用 `SessionManager::message_dedup()`。
- **连接时增量对账**：
  - `backend/cloud_api/mod.rs:1276` 的 `ListItem` 加 `lastMessageAt`——该字段
    `GET /v1/sessions` 本来就返回（`Session` schema），现在被 serde 丢弃了。
  - `OfflineRestartPlanner` 增加增量模式：只对 `lastMessageAt` 晚于水位线的会话跑
    `plan_session`。
  - 在 MQTT 连上的回调（`daemon/server.rs:1067` 附近，现在只做
    `resubscribe_tracked_live_sessions`）触发增量对账。
  - 水位线只在内存，进程重启即回退全量扫描（现状行为）。

### PR-3 · 客户端按 message_id 去重 + B1

- 桌面 `packages/app/src/components/MqttLiveWiring.tsx:741` 的闸门现在对
  `/session/` 上**所有**事件都按 `envelope.eventId` 去重。`event_id` 是每次 publish
  现生成的，两个发布方发同一条消息会产生两个 eventId → 消息显示两遍。
  改为：`message.created` 按 `message_id` 去重，其余事件仍按 `eventId`。
- iOS 同等处理。
- **B1**：iOS 订 `inbox/<memberActorID>`，FC 发 `inbox/<auth user id>`，两个 UUID
  不同，iOS 这条 inbox 现在收不到任何东西。改 iOS 侧。
- 本 PR 向前兼容：FC 尚未开始发，改了也看不出区别，但它决定 PR-4 最早何时能发。

### PR-5 · 收口重写（风险最高）

拆分后流式与 final 来自两个发布方，跨发布方无顺序保证，且 FC 在 INSERT 提交后即
扇出、早于 daemon 的 `turn.ended`——**final 先于最后几个增量到达会成为常态**。

- join key 用 `turn_id`（`amux.messages` 有该列，iOS `MessageRecord.turnID` 已在读），
  不能依赖 `turn.ended` 先到。
- finalize 必须幂等可重入：重复 `message_id` 丢弃；finalize 后的迟到增量丢弃、
  **不重开已收口的条目**；没见过流式直接收到 final 则直接渲染、不走合并。
- **以 FC 的 `message.created` 收口**，`turn.ended` 只清 turn 级状态。反过来的话，
  daemon 在 turn 结束瞬间掉线，`turn.ended` 永不到达，UI 会一直转。
- 合并规则**不新写**：走现有唯一入口 `reconcileEquivalentAgentReplyText`
  （`packages/app/src/lib/agent/agent-reply-transcript.ts`）。该模块有构建门禁，
  出现第二个 `pickCanonicalAgentReplyText` 的 importer 会直接让构建失败。

建议单独发布、单独验证，不与其他 PR 混合。

## 5. 已知会留下的缺口

| 缺口 | 何时关闭 |
|---|---|
| 客户端 live publish 与 FC 写入是两条独立的路，publish 失败则其他在线客户端要刷新才看到（B4） | PR-4 + PR-5 |
| 中途进入会话看不到本轮前半段（`request_recent_session_events` 是空实现，`session_manager.rs:1591`） | 独立缺口，需 `FetchTurnEvents`，不在本次范围 |
| agent 无法实时观看另一个 agent 的 turn 过程 | 现状即如此（`ingest_session_live` 丢弃非 `message.created`），本次不引入也不恶化。将来「任务拆解 / 子任务委派」需要时，按 turn 订阅、turn 结束退订即可——函数保留着，接触发条件就行 |
| EMQX ACL 与实际流量不符（B6） | Phase 4 |
| OSS 轨迹无保留期策略 | 独立跟进 |

## 6. 验收

- daemon 进程重启后，在**任意既有会话**里 @ 它都能收到并应答，不需要任何客户端先
  打开会话或启动 runtime。
- daemon 断网数分钟后恢复，期间发送的 @ 在重连后被应答（走连接时对账）。
- 桌面与 iOS 观看远端 agent 流式输出的行为不变。
- PR-5 之后：同一条消息不出现两次；turn 结束后 UI 不再抖动；daemon 在 turn 末尾
  掉线时 UI 仍能正常收口。
