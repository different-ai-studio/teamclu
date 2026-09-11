# TeamClu 功能详解 · 第 3 篇：会话协作与实时消息

> 版本基线：当前 `main`（`package.json` v0.4.1-beta.51）。
> 读者：要接手会话/消息/流式/实时这块的工程师。
> 关联：`docs/architecture/session-threads.md`、`docs/architecture/v2.md`、
> ADR-0003、ADR-0005、ADR-0011、`CLAUDE.md` 的 Streaming Architecture 一节。

---

## 0. 一句话定位

会话（session）是 TeamClu 的**协作单元**：一个会话里有若干 actor（人和 agent），他们在同一个上下文里对话、调用工具、产生结论。消息（message）是会话的原子记录，流式（stream）是消息在生成过程中的临时形态。

这三者构成了 TeamClu 与「一个聊天 App」最本质的区别：

- **聊天 App 的原子是消息**，会话只是消息的容器；
- **TeamClu 的原子是会话**，消息只是会话里的一个事件。会话有参与者、有权限、有绑定的 agent、有工作区、有来源（手动/定时/通道/线程）、有生命周期。

理解这一点，就能理解为什么会有这么多看起来「重」的机制：参与者缓存、runtime 绑定、会话来源、权限队列。它们都不是为了显示消息，而是为了维护会话这个对象。

---

## 1. 三种 actor

会话里的发言者叫 actor。ADR-0001 把 actor 类型简化为两种：

- **member**：人，对应一个用户；
- **agent**：AI，由 daemon 驱动。

但实际呈现时有三种视觉身份，因为「self」在 UI 上要区别对待：

| 身份 | 判定 | 气泡样式 |
|---|---|---|
| self（你） | `actor.id === 当前用户 actor` | 深色 ink 气泡，白字，右对齐 |
| 其它 member | type=member 且不是自己 | paper 气泡 + 边框，左对齐 |
| agent | type=agent | **不是气泡，是「笔记」** |

**agent 回复不是气泡，是笔记（note）。** 这是整个聊天 UI 里最重要的一个视觉决定，细节见第 3 节。原因是：agent 的回复往往包含结构化内容（要点、代码、后续建议），塞进一个圆角气泡会让它看起来像「某人在随口说一句」，而它实际是「一份可引用的产出」。

actor 的颜色来自 `actorAvatarColor(actorId)`，形状上 agent 用圆角方形、人类用圆形。这些小规则的作用是：**在不加文字徽标的前提下，让人一眼看出这条消息是谁说的、是人是 AI。**

---

## 2. 会话模型

### 2.1 会话的来源

`lib/session/session-origin.ts` 与会话类型字段决定一个会话从哪里来：

| 来源 | 说明 | 在列表里的表现 |
|---|---|---|
| 手动 | 用户新建 | 正常显示 |
| 定时（scheduled） | cron 触发 | 由 `isScheduledSession` 识别，可被过滤 |
| 线程（thread） | 从某条 agent 回复分叉 | 主列表隐藏，在 `ThreadPanel` 里 |
| 通道（gateway） | 外部 IM 消息创建 | 带通道徽标 |
| 应用（app） | app 的会话 | 第二列在 app 上下文里 |

会话来源不是一个展示字段，它影响行为：定时会话的计数要从主列表排除；线程会话不参与主列表分页；通道会话的权限由 daemon 自动批准。

### 2.2 会话与 agent 的绑定

一个会话绑定一个 agent（ADR-0002：一个 actor 只运行一种 agent 类型；ADR-0005：participant 拥有 per-agent session state）。绑定关系在 daemon 的 `runtimes.toml` 里，前端通过 runtime 状态感知。

一个容易混淆的点：**会话里的 agent 是参与者，不是「服务端」**。所以 agent 可以离线、可以被限制权限、可以在会话中途换模型。前端要能表达这些状态，这就是 `session-agent-ui-state.ts` 存在的理由。

### 2.3 会话列表

会话列表在第二列（`SessionListColumn`），细节见第 1 篇第 15 节。这里只补一条与会话模型相关的：**列表的真相源是 `useSessionListStore.rows`**，而 `useSessionStore.sessions` 仍在喂 `pinnedSessionIds`、`highlightedSessionIds`、`activeSessionId` 和活动徽标。这是双 store 遗留层，迁移完成前不要假设两者一致。

---

## 3. 消息模型与 agent 回复的「笔记」形态

### 3.1 message.parts[]

一条消息的最终内容来自 `message.parts[]`。为什么要用 parts 而不是一个 `content` 字符串？因为一条 agent 回复可能包含多种块：文本、思考、工具调用、工具结果、引用。用 parts 数组表达，渲染层按块类型分发，比在一个字符串里做标记解析干净得多。

这也解释了流式的复杂度：流式期间还没有最终的 parts，只有一串 delta。所以有「流式阶段看 stream store，完成阶段看 message.parts」这条分工。

### 3.2 agent 回复的四个组成部分

一条 agent 回复在 UI 上最多有四个部分：

1. **头像 + 名字 + AI badge + 模型 · 时间 + 复制/刷新图标**；
2. **正文段落**（13.5px / 1.7）；
3. **可选的要点网格**：顶部虚线分隔，两列 `auto 1fr`，左列 muted 标签、右列 ink 值；
4. **可选的后续建议 pill**：paper 底、边框、12px、8px 圆角。

缩进 33px，让正文对齐头像列下方——这是「笔记」的视觉签名。它和气泡最大的区别是：气泡的宽度由内容决定，两边留白大；笔记占满可用宽度，像一个文档段落。

### 3.3 用户消息

用户消息是气泡：

- 气泡上方是说话者名字 + 16px 小头像；
- 自己用深色 ink 气泡（`--foreground` 底，`#fefdfa` 字）；
- 其它人用 paper 气泡 + 边框；
- `max-w-[65%]`，padding `10px 14px`，圆角 16px，**右下角 6px**（「说话者角」）；
- 13.5px / 1.6。

### 3.4 工具调用卡片

工具调用不是消息，是消息里的一个块。缩进 33px，8px 圆角 paper 卡片，两行：

```
● tool  tool_name(arg: "value", ...)        ok · 0.4s
→ result text, truncated on the right
```

全部 mono 11.5px。状态点颜色：成功 `#2eb872`，失败 `var(--destructive)`，进行中 `#e8b54a`。首行有微弱底色 `#fbf9f4`，次行是 paper。

工具调用的解析在 `components/chat/tool-calls/`，卡片在 `ToolCallCard.tsx`。**把解析单独拆出去**是因为工具名称和参数格式会随 runtime 变，而卡片渲染不应该跟着变。

---

## 4. 流式管线（最关键的一节）

CLAUDE.md 把这块单独列为一节，因为它是历史上出过 bug 最多的地方。规则只有几条，但每条都不能违反。

### 4.1 单一来源原则

- **流式阶段**：从 v2 stream entry（`useV2StreamingStore`，built from the delta buffer）显示。v1 的 `useStreamingStore` 已经删除。
- **完成阶段**：从 `message.content`（由 `message.parts[]` 构建）显示。
- **绝不**在流式期间写 `msg.content`。
- **绝不**在完成时用「最长内容」策略合并。

### 4.2 唯一的 reconcile 点

**完成内容的 reconcile 只在一个地方发生**：`deriveAgentReplyContent`（`packages/app/src/lib/agent/agent-reply-transcript.ts`），且 `stores/v2-stream-parts.ts` 的 finalize 路径会走它的 `reconcileEquivalentAgentReplyText`。

它的规则是：当流式文本与 daemon 最终内容在 **whitespace 归一化后是同一段文本**时，保留更长的那个。原因是 MQTT QoS0 可能丢掉工具调用后的 delta，而 daemon 的 final 带着尾部。**文本不同时，绝不按长度合并。**

`pickCanonicalAgentReplyText` 只能被那个模块 import；`lib/__tests__/agent-reply-single-reconciliation.test.ts` 会在出现第二个 importer 时让构建失败。

### 4.3 为什么这么严

因为「两个源都写同一个字段」必然导致跳变。具体表现是：用户看到流式文字出来了，然后完成的一瞬间，文字变短了或重复了。这类 bug 极难复现（取决于丢不丢 delta），但用户会立刻察觉「AI 说话怪怪的」。

修法不是「更小心地合并」，而是**让其中一个源成为唯一真相源，另一个成为它的纯函数**。这也是 ADR-0011 的内容。这个模式在第 1 篇第 28 节里被总结为一条通用教训。

### 4.4 delta 缓冲

流式 delta 进入一个缓冲区，`useV2StreamingStore` 从缓冲区构建显示内容。这样做的目的是**按帧合并**：模型可能每秒吐几十个 delta，逐条触发 React 渲染会卡。缓冲 + 构建让渲染频率与 delta 频率解耦。

`docs/architecture/` 与 `docs/plans/` 下有多份关于流式的设计；读代码时从 `stores/v2-stream-parts.ts` 与 `lib/stream/` 入手。

---

## 5. 实时：MQTT session/live

### 5.1 主题

会话内的实时通信走 `amux/<team>/session/<sid>/live`。这个主题上的消息有两类：

- **业务事件**：新消息、消息编辑、参与者变化；
- **agent 事件**：流式 delta、工具调用、状态变化。

`MqttLiveWiring.tsx` 是接线组件：它根据当前活跃会话建立订阅，切换会话时重新订阅。`stores/session-live-interest-store.ts` 记录「哪些会话现在需要实时」，这是一个引用计数——多个窗口/多个面板可能同时关心同一个会话。

### 5.2 QoS 与丢包

session/live 走 QoS0（最多一次），意味着 delta 可能丢。这就是为什么流式的最终 reconcile 需要「保留更长的那个」——它是对 QoS0 的现实补偿，而不是一种「聪明合并」。

业务事件（新消息）不允许静默丢。如果一条业务消息丢了，界面上会表现为「队友发了一条我看不到」。这块的兜底是历史重拉：`SessionHistoryLoader`、`ThreadHistoryLoader` 会在打开会话时补拉。

### 5.3 MQTT 的桥

`lib/mqtt/` 里有多套 broker 桥：

- Tauri 桥（桌面，Rust 侧连）；
- browser 桥（web / 扩展）；
- worker 桥。

它们对上层暴露同一套接口，所以 `MqttLiveWiring` 不需要知道自己在哪个平台。诊断信息也在 `lib/mqtt/`。

### 5.4 认证

MQTT 用 JWT access_token 做密码。ACL 由 GoTrue 的 `amux_access_token_hook` 在签发时展开成 `acl` claim 烘进 token。EMQX 侧只配了 JWT 认证，没有 authorization 块，也没有 Postgres authz 源——**ACL 完全跟着 token 走**。

token 只活 3600s。daemon 到期前 60s 续、到期前 5 分钟主动重建 MQTT 连接并逐条重订阅（`PROACTIVE_CREDENTIAL_BUFFER`）。前端侧有自己的刷新路径。

一个与知识库同步相关的细节：如果订阅被拒，daemon 会走 `request_rebuild_for_generation` 触发 worker 重建。所以新增订阅必须是「可选订阅」（被拒只 warn 不重建），否则一次 ACL 迁移会让 RPC、session live、presence 全部跟着断。详见第 5 篇。

---

## 6. 线程（session threads）

### 6.1 规则

`docs/architecture/session-threads.md` 定得很清楚：**只有 agent_reply 消息能开线程**。线程是一个**新的云会话**（`source=thread`）带 `parent_session_id` + `thread_root_message_id`，从主会话列表隐藏。

为什么只允许 agent 回复开线程？因为线程的用途是「就 agent 的某一句话展开讨论」。如果任何消息都能开线程，会话树会长成一团。

### 6.2 懒 fork

Pi 后端在第一次 `runtimeStart` 时才 fork：

1. 客户端发 `RuntimeStartRequest.fork_from { parent_session_id, root_message_id }`；
2. daemon 读父 `runtimes.toml` 绑定 + anchor 消息的 `metadata.backend_session.fork_point.pi_leaf_id`；
3. Pi host `fork_session` → `SessionManager.createBranchedSession(leafId)` → 新的 `pi:/path.jsonl`；
4. 线程 runtime 用 `resume_acp_session_id` 附着，并带 `forbid_new_session_fallback`。

懒 fork 的价值是：用户点「在新线程里讨论」但还没发消息时，不产生任何后端开销。

### 6.3 API 与 UI

- `POST /v1/sessions/{parentId}/threads` `{ rootMessageId }`（幂等）
- `GET /v1/sessions/{parentId}/thread-summaries`

UI 是聊天列里的右侧 380px `ThreadPanel`，双 composer（主会话 + 线程）。相关组件：`ThreadPanel.tsx`、`ThreadListPanel.tsx`、`ThreadBadge.tsx`、`ThreadAnchorPreview.tsx`、`SessionThreadsHeaderButton.tsx`。fork 元数据在 `lib/session/thread-fork.ts` 与 `thread-fork-metadata.ts`，摘要在 `thread-summary.ts`。

### 6.4 与知识库冲突的类比

线程的「一个会话派生另一个会话」和知识库的「冲突副本」有一个共同的设计要求：**派生出来的东西必须有独立的身份，否则它会被原对象的状态机误伤。** 知识库的冲突副本因此放进独立的 `.conflicts/` 目录（否则会被扫描器当作本地删除广播）；线程因此是一个独立的 cloud session（否则主列表分页、置顶、活动徽标都会算错）。

---

## 7. 参与者、在线与提及

### 7.1 参与者

`session_participants` 是会话的成员表。前端 `useSessionParticipantStore` 懒加载并缓存。已知缺口：第二列的 `participantsBySession` 缓存**从不失效**，realtime envelope handler 看到 `session_participant` 变化时应该戳它，目前没有。用户会看到过期的头像直到列重新挂载。

`ensureParticipants` 是 remote-tools 的前置校验（fail-closed）：除非 requester 是 session agent 且参与者已加载，否则 RPC 被拒绝。

### 7.2 在线

`actor-presence-store` / `useActorPresenceStore`。在线状态通过 MQTT `actor/state` 广播。人类 actor 的在线点显示在头像右下角，agent 用珊瑚点。

一个细节：**presence 是 actor 级的，不是 session 级的。** 所以同一个人在两个会话里都是在线。

### 7.3 提及

`@` 提及走 `MentionPopover.tsx`，消息渲染走 `UserMessageWithMentions.tsx`，解析在 `lib/actor/`。提及在团队资产里驱动「@Mentions」这个快捷入口。

**提及不是权限。** 被提及不等于被加入会话。这个区分在网关场景里尤其重要：通道里 @bot 的语义是「这条消息是给 agent 的」，而不是「把这个人拉进会话」。

---

## 8. 引用、回复与消息动作

- 引用：`AgentReplyQuote.tsx`；用户回复某条 agent 回复时，把那条回复作为上下文附上。
- 消息动作：`MessageActionIconButton.tsx`、复制、重新生成、反馈（`MessageFeedback.tsx`）、星级（`MessageStarRating.tsx`）。
- 状态点：`MessageStatusDot.tsx`（发送中/已送达/失败）。
- token 用量：`MessageTokenUsage.tsx`、`MessageTokenSummary.tsx`、`ContextUsageBadge.tsx`。

这些「消息级动作」看起来零碎，但它们决定了 agent 的产出能不能被沉淀：**复制**用于把结论带走，**反馈/星级**用于给 agent 打分，**token 用量**用于让人知道这次花了多少。

---

## 9. 权限与提问

### 9.1 权限

agent 执行工具前可能需要批准。这条链路：pi extension 拦阻 → `confirm` dialog → daemon → 前端 `AcpPermissionRequest` → 用户选择 → `ResolvePermission` → daemon → extension。

前端组件：`PermissionCard`、`PermissionApprovalPanel`、`PendingPermissionInline`、`PermissionWaitingBanner`、`PermissionApprovalModeSelect`。队列逻辑在 `permission-queue.ts` 与 `use-pending-permissions-queue.ts`，呈现统一在 `permission-presentation.ts`。

**gateway 会话自动批准**（`is_gateway`），因为无人值守。

### 9.2 提问（question）

pi 的 extension 注册了一个 `question` 工具，经带 `teamclu.question=` 标记的 `select` dialog 走同一 UI 通道，amuxd 译成 `question_asked`。前端 `QuestionCard.tsx` + `QuestionInputDock.tsx` 渲染。

提问与权限的区别是：权限是「要不要做」，提问是「答案是什么」。所以提问的 UI 需要输入，而权限只需要选择。

---

## 10. 持久化、outbox 与离线

消息的写入有两条路径：

- **在线**：直接写 Cloud API；
- **离线**：写 outbox，联网后由同步器发出。

相关：`lib/messages/`（消息行、收件箱、发件箱展示、发送路径选择）、`stores/`、`OfflineSendConfirmDialog.tsx`、`offline-send-preference-store`。

一个设计原则：**发送路径的选择对用户是可见的。** `OfflineSendConfirmDialog` 存在的原因是：用户按了发送，但不应该以为消息已经出去了。如果它只是排队，界面必须说清楚。

本地缓存（libsql）镜像 message 行，所以离线时也能读历史。见第 1 篇第 20 节。

---

## 11. 搜索、导出与历史

- **搜索**：`session-search-dialog.tsx`、`lib/search` 相关；会话列表也有搜索。
- **导出**：`lib/session-export/` + `ExportPiTranscriptButton.tsx`。pi 的转录可以单独导出。
- **历史加载**：`SessionHistoryLoader.tsx`、`ThreadHistoryLoader.tsx`。打开会话时补拉遗漏的消息。
- **版本历史**：`lib/history/` + `components/version/`，用于文件而非消息（知识库文档、skill 文件）。

---

## 12. 通知与活动

- 未读/新消息信号：FC 往 `inbox/<uid>` 发 MQTT 信号（`services/fc/src/lib/push-dispatch.ts`）。
- 活动徽标：会话列表上的活动标记。
- `session-notice-store.ts` / `SessionNoticeList.tsx`：会话内的系统提示（比如「agent 被替换了」「权限模式变了」）。

会话内的 notice 是一个容易被忽视但很重要的机制：**当会话的某个隐含状态变了（agent 离线、模型切换、权限模式变化），用户需要知道，否则他会把「行为变了」误解成「AI 变笨了」。**

---

## 13. 与 Cloud API 的会话端点

业务数据走 `/v1/sessions`、`/v1/messages`、`/v1/invites`。线程有 `/v1/sessions/{parentId}/threads`。契约在 `docs/openapi/teamclu-api.v1.yaml`。

一个边界：**auth/team 相关的会话操作**（谁能在会话里发言）由 RLS 与 participant 表决定，不是前端判断。前端只做展示层的禁用。

---

## 14. 性能

会话与消息的性能约束点：

1. **会话切换**：见第 1 篇第 25 节。
2. **消息渲染**：长会话避免全量重渲染。
3. **流式渲染**：按帧合并 delta。
4. **参与者加载**：懒加载 + 缓存（但缓存失效是已知缺口）。
5. **token 用量**：按完成事件更新，不跟 delta。

`docs/plans/2026-08-09-session-switch-perf-requirements.md` 是这块的预算来源。

---

## 15. 测试

- `stores/*.test.ts`：`session-message-store.test.ts`、`session-participant-store.test.ts`、`session-selection-store.test.ts`、`session-list-store.test.ts`、`session-store.test.ts`。
- `lib/__tests__/agent-reply-single-reconciliation.test.ts`：守卫唯一的 reconcile 点。
- `lib/session/session-live-subscriptions.test.ts`：订阅管理。
- E2E：`tests/v2-e2e/`。

---

## 16. 关键文件索引

```
packages/app/src/
  components/chat/                     聊天面板与所有消息相关组件
    ChatPanel.tsx                      第三列聊天
    ChatInputArea.tsx                  输入
    ChatMessage.tsx                    消息分发
    StreamingAgentBubble.tsx           流式展示
    ToolCallCard.tsx                   工具调用
    ThreadPanel.tsx / ThreadListPanel.tsx
    PermissionCard.tsx / QuestionCard.tsx
    MessageList.tsx
  components/chat/tool-calls/          工具调用解析
  MqttLiveWiring.tsx                   实时接线
  SessionHistoryLoader.tsx
  stores/
    session-message-store.ts
    session-participant-store.ts
    session-list-store.ts
    session-live-interest-store.ts
    v2-stream-parts.ts
    session-notice-store.ts
  lib/
    session/                           会话生命周期、来源、fork、导出
    messages/                          消息行与发送路径
    stream/                            流式管线
    mqtt/                              broker 桥
    agent/agent-reply-transcript.ts    唯一 reconcile 点
```

---

## 17. 常见坑

1. **流式期间绝不写 `msg.content`。** 这是硬规则。
2. **不要新增第二个 reconcile 点。** 守卫测试会挂。
3. **不要按长度合并不同文本。** 只有归一化后相同时才保留更长。
4. **参与者缓存不会自动失效。** 改动它时要显式刷新。
5. **业务消息不允许静默丢。** delta 可以丢，消息不行。
6. **线程是独立 cloud session。** 不要把它当成一个 UI 概念。
7. **提及不是权限。** 不要用它做访问控制。
8. **gateway 自动批准权限是有前提的。**
9. **新订阅要考虑 ACL 迁移。** 见第 5 篇的「可选订阅」。
10. **发送路径要可见。** 排队不是发送。

---

## 18. 一次会话的完整数据流（从创建到归档）

把会话当作一个对象，它的生命周期是这样演进的：

**创建。** 用户在第二列点「新会话」，或 cron 触发，或通道收到消息，或从某条 agent 回复开线程。四条路径最终都调 `session-create.ts`，区别只在 initial 的 source 与参与者。

**绑定。** 会话创建后需要绑定一个 agent。绑定发生在 daemon 的 `runtimes.toml`，但前端首先要把「这个会话要用哪个 agent」告诉 daemon。如果用户没有选，走默认 agent；如果团队设了默认 agent，用它。所以「新建会话」这个动作实际上在两个层面发生：云端行（session）与本地绑定（route）。

**启动。** 第一条消息之前，runtime 要就绪。`ensure-agent-runtime` 确保它存在；如果 agent 所在设备离线，界面显示 `EngagedAgentOfflineBanner`；如果 runtime 在冷启动，显示 `SessionContinueBanner`。

**对话。** 消息双向流动：用户消息写入云端并广播到 `session/live`；agent 事件从 daemon 流出，一路进 MQTT，一路回给发起请求的客户端。

**工具与权限。** 需要权限时出现卡片，`permission-queue` 管理排队。多个人同时在一个会话里时，权限请求归属到发起该 turn 的人（remote-tools 的 `remote_context_id` 机制同一套逻辑）。

**结束。** 会话不会「结束」，但会进入不活跃。列表按活跃度排序，`session-list-activity.ts` 决定活动时间。

**归档。** `session-archive` 相关入口（introspect API 有 session archive）。归档后不在主列表，但历史仍在。

**导出。** `lib/session-export/` 把一段对话导出成可携带的格式；pi 的转录可以用 `ExportPiTranscriptButton` 单独导出。

这条演进路上，每一段都有对应状态字段和 UI 表现。一个常见的误解是「会话就是一串消息」——实际上消息只是生命周期中最长的那一段，前后还有创建、绑定、启动、归档。

---

## 19. 会话与 daemon runtime 的交互

会话不直接和 pi 对话，中间隔着 daemon。这条边界上的关键请求：

| 前端请求 | daemon 行为 |
|---|---|
| `RuntimeStartRequest` | 确保 runtime 存在，必要时 fork |
| 发 prompt | 译成 pi prompt，在 host 里跑一个 turn |
| abort | 只中断这个会话的 turn |
| 权限应答 | 写回 extension |
| question 答案 | 写回 extension |
| 换模型 | 会话级 `set_model` |
| runtime 状态查询 | 读 daemon 注册表 |

一条重要区分：**「会话存在」不等于「runtime 存在」。** 一个会话可以没有任何 runtime（agent 离线时），也可以有多个 runtime 历史（换了设备、换了模型、崩溃重启）。所以前端不能把 runtime 状态与会话状态混为一谈。

`lib/teamclu/` 里的文件就是这些请求的封装：`agent-transport.ts`、`runtime-command.ts`、`runtime-ensure-scheduler.ts`、`interrupt-agent.ts`、`answer-question.ts`、`subagent-acp-binding.ts`。

---

## 20. 子 agent 与会话

除了主 agent，会话里还可能出现子 agent（subagent）。`subagent-acp-route.ts`、`subagent-acp-routing.ts`、`subagent-acp-binding.ts` 处理子 agent 的事件归属——一个子 agent 的事件不能被算到主会话的头上，也不能算到别的子 agent 头上。

这块的设计与多会话 host 是同一个问题的两个尺度：

- 多会话：一个 host 进程里有多个 `AgentSession`，事件按 `sessionId` 路由；
- 子 agent：一个会话里可能有多个 agent 实体，事件按 subagent route 路由。

两者都不能串。一旦串了，症状是「A 的回复出现在 B 的会话里」或「主 agent 的说法与子 agent 混淆」，非常难查。

---

## 21. 动态 UI 与会话

`lib/dynamic-ui/` 允许 agent 编写 UI 描述并渲染成界面。它的入口与安全考虑：

- **目录组件**（catalog）限制 agent 能用的组件；
- **prompt** 告诉 agent 可用的形状；
- **registry** 做渲染分发；
- **streaming** 支持边生成边渲染。

为什么它属于会话而不是单独一个功能？因为它服务于「agent 不只是说话，还能把结论变成可交互的表单/图表」。所以它的入口在聊天里，产出在聊天里。示例场景：agent 把一组选项给用户选，而不是让用户打字。

安全边界：动态 UI 只能使用目录里的组件，不能执行任意代码。这是它与「让 agent 写 React」的根本区别。

---

## 22. 通知与 inbox

新消息不一定需要实时订阅。一个不在当前窗口打开的会话有了新消息，用户应该收到通知而不是订阅所有会话。

实现是：FC 在写入成功后往 `inbox/<uid>` 发一个 MQTT 信号（`services/fc/src/lib/push-dispatch.ts`）。前端订阅自己的 inbox，收到信号后拉未读状态并展示徽标。

这个设计把「订阅」和「通知」分开：

- 会话内的实时（`session/live`）只对「当前打开的会话」订阅；
- 通知（`inbox/<uid>`）是一个轻量信号，让用户知道「有东西变了」。

如果两者混在一起，就需要为用户的每个会话维持订阅，这在有很多会话时不可行。

---

## 23. 会话内的 notice：状态变化的可见性

`session-notice-store.ts` / `SessionNoticeList.tsx` 是一类特殊的消息：不是人和 agent 说的话，而是**系统告诉用户会话状态变了**。

什么时候会产生 notice？

- agent 被替换（原来的 agent 离线，另一个接手）；
- 模型被切换；
- 权限模式改变；
- 某个操作失败且需要用户知道。

为什么这很重要？因为会话是一个「隐含有状态」的东西。用户看到的是消息流，但消息流背后的 agent、模型、权限都可能变。如果变化不被说出来，用户会把「行为变了」当成「AI 变笨了」，然后开始不信任它。

这条与第 2 篇的「agent 层不会静默失败」是同一条原则的两个应用。

---

## 24. 阅读代码的建议顺序

1. `docs/architecture/session-threads.md` —— 先看线程为什么是独立 session。
2. `CLAUDE.md` 的 Streaming Architecture 一节 —— 流式规则。
3. `lib/agent/agent-reply-transcript.ts` —— 唯一的 reconcile 点。
4. `stores/v2-stream-parts.ts` —— 流式状态。
5. `components/chat/ChatMessage.tsx` —— 消息分发。
6. `MqttLiveWiring.tsx` —— 实时接线。
7. `stores/session-message-store.ts` —— 消息状态。
8. `lib/session/` 选一个文件（建议 `session-origin.ts`，最短）—— 会话来源。

不建议一开始读 `ChatPanel.tsx`，它是整个聊天列的组装，包含输入、消息列表、线程、权限、提问、流式，会在没有上面上下文时显得无比庞大。

---

## 25. 维护约定

本文与以下内容强耦合，变动时要同步：

- **流式规则变了**（不再是单一 reconcile 点），第 4 节要重写，并检查 ADR-0011。
- **线程不再是独立 session**，第 6 节要重写，并检查 `session-threads.md`。
- **参与者缓存失效补上**，第 7.1 节与第 1 篇的对应段落要改。
- **QoS 从 0 改掉**，第 5.2 节的丢包讨论要改。
- **通知改走别的通道**，第 22 节要改。

一条写作约定：会话这块的文档最容易变成「需求描述」，因为功能之间的关系很自然。要避免写成「应该怎样」，只写「现在是什么」。当一个机制存在但没用（比如 Thinking 块目前在代码里但不渲染），要说清楚「代码在、不渲染」。

---

## 26. 附录 A：与会话相关的全部 store

前端 50+ 个 store 里，与会话直接相关的：

| store | 职责 | 备注 |
|---|---|---|
| `session-list-store.ts` | 主列表行、分页、游标 | 列表真相源 |
| `session-store.ts` | 旧层：active、pinned、highlighted、活动 | 遗留，待迁 |
| `session-message-store.ts` | 会话消息 | |
| `session-participant-store.ts` | 参与者 | 懒加载 |
| `session-selection-store.ts` | 选中与高亮 | |
| `session-live-interest-store.ts` | 哪些会话需要实时 | 引用计数 |
| `session-notice-store.ts` | 会话内系统提示 | |
| `session-pins.ts` | 置顶 | |
| `v2-stream-parts.ts` | 流式与最终内容 | 单一 reconcile |
| `team-conflicts.ts` | 文件冲突（知识库） | 与会话并列 |
| `version-history` | 版本历史 | 文件维度 |
| `actors-store.ts` / `actor-presence-store.ts` | actor 目录与在线 | |
| `cron.ts` | 定时任务与定时会话 | |
| `oss-sync.ts` | 同步状态 | 与知识库共享 |

为什么有这么多个？因为 store 的粒度是「谁读写同一份东西」。把会话列表、消息、参与者、选中、实时兴趣分开，是为了让每一块独立重渲染。合并成一个大 store 会让「一个参与者变化触发整个列表重渲染」。

这条与第 1 篇的 window-local 规则配合：**每个 store 都是 window-local 的，各自挂一份。** 所以两个窗口的会话列表可能不同步，这是被接受的。

---

## 27. 附录 B：消息渲染的视觉规则汇总

把散落在 AGENTS.md 的规则聚合到一张表，方便写组件时对照：

| 元素 | 字号 / 样式 | 备注 |
|---|---|---|
| 会话标题 | 13px / 600 | 卡片标题 |
| 卡片预览 | 12px | meta 行 |
| 消息正文 | 13.5px / 1.6 | 用户气泡 |
| agent 回复正文 | 13.5px / 1.7 | 笔记 |
| agent 回复次要 | 12.5px | |
| 时间戳 | 11px mono | faint |
| 工具卡片 | 11.5px mono | 全部 mono |
| 分组分隔 | 10.5px / 600 / uppercase | tracking 0.8 |
| AI pill | 9.5px mono / 600 | |
| 键盘 pill | 11px mono | |

圆角：section/panel 14px；卡片/气泡大边 16px、说话者角 6px；按钮/pill 7–8px；inline chip / mono key pill 3–4px；工具卡 8px。

间距：侧栏项 `7px 9px`；聊天项间 8–12px；卡片内 10–14px；section header 14–16px。

这三张表合在一起是「密度优先」的实现：字号小、间距紧、但卡片内部留白。改任何一个值之前先想一下它会不会破坏圆角与间距的对应关系（比如把卡片圆角从 16 改成 12，说话者角的 6 就不再是它的二分之一）。

---

## 28. 附录 C：常见错误与修法

| 错误 | 症状 | 正确做法 |
|---|---|---|
| 流式期间写 message.content | 完成瞬间文字跳变 | 写完才写 |
| 用长度合并不同文本 | 重复或变短 | 只归一化后相同时合并 |
| 在组件里再解析一遍工具调用 | 与卡片不一致 | 用 tool-calls/ 的解析 |
| 把线程当 UI 概念 | 列表/钉钉/活动全算错 | 它是独立 cloud session |
| 用提及做权限 | 被提及就能看 | 提及只是上下文 |
| 假定参与者缓存最新 | 头像过期 | 显式刷新 |
| 在 delta 上挂重查询 | 渲染卡 | 按完成事件更新 |
| 发消息后不告诉用户是否入队 | 用户以为已发出 | 显示发送路径 |
| 在会话里硬编码 agent 名字 | 换 agent 后错 | 从 actor 取 |
| 把 runtime 状态当会话状态 | agent 离线时 UI 错 | 分开表达 |

---

## 29. 附录 D：术语

| 术语 | 含义 |
|---|---|
| session | 协作单元，云端有行 |
| message | 会话里的消息，含 parts |
| part | 消息里的块（文本/工具/思考） |
| delta | 流式增量 |
| stream entry | v2 流式条目 |
| reconcile | 流式与最终的归一 |
| thread | 从 agent 回复分叉的 session |
| participant | 会话成员 |
| actor | 发言者（人/agent） |
| fork point | 线程分叉的销（leaf id） |
| route | TeamClu session ↔ pi session 绑定 |
| source | 会话来源（手动/定时/线程/通道） |
| outbox | 离线发送队列 |
| notice | 会话内系统提示 |

---

## 30. 附录 E：FAQ

**Q：为什么消息用 parts 而不是字符串？**
A：因为一条回复可能包含文本、工具、思考、引用。用一个字符串表达需要在渲染时做标记解析，而标记本身可能出现在用户内容里。

**Q：流式为什么不能直接写最终字段？**
A：因为流式是增量的，最终字段是完整的。两个写者必然打架。

**Q：为什么 delta 可以丢而消息不能？**
A：因为 delta 是过程，消息是结果。过程丢了下一个 delta 会补上，结果丢了就是真的丢了。

**Q：线程为什么不能从用户消息开？**
A：因为线程的语义是「就 agent 的某一句话展开」。如果任意消息都能开，会话会长成一棵树，而 UI 无法表达。

**Q：为什么一个会话只能绑定一个 agent？**
A：ADR-0002。actor 的类型是身份，不是运行时参数。要换 agent 就是换参与者，会产生 notice。

**Q：多个人同时在一个会话里，消息会不会冲突？**
A：消息是追加的，不会冲突。会冲突的是**权限请求**，归属由发起 turn 的人决定。

**Q：为什么我看不到未读数字？**
A：本地 schema 没有 read marker。卡片预留了槽位，但还没实现。订阅 `inbox/<uid>` 的通知是有的。

**Q：历史消息什么时候拉？**
A：打开会话时由 `SessionHistoryLoader` 补拉。实时订阅只覆盖打开后的新事件。

**Q：能导出吗？**
A：能，`lib/session-export/` 与会话导出按钮；pi 转录单独导。

---

## 31. 附录 F：消息的安全与隐私

会话里的消息可能包含敏感信息。几条现状：

**传输。** 客户端到 Cloud API 走 HTTPS，MQTT 走 TLS。MQTT broker 内部是明文，运维可见——这是为什么知识库的 sync hint 不带路径（见第 5 篇第 7 节），也是为什么敏感内容不应该依赖 MQTT 本身保密。

**存储。** 消息在 Postgres 里，由 Supabase RLS 保护。RLS 的语义是「你是不是这个团队的成员/参与者」。

**本地。** 消息行会镜像到本地 libsql 缓存（`local-cache.db`），所以「登出后本地还有多少聊天记录」是一个需要认真对待的问题。目前的处理是缓存在 brand home 下，不在 workspace 里。

**发送工具参数字符串。** 工具调用卡片里会展示参数，参数字符串里可能包含路径、命令、URL。它走同一套存储与传输。

**脱敏。** `lib/diagnostics/` 有脱敏逻辑，但它服务的是诊断与日志，不是消息。

一条产品叙事上的纪律：**不要把会话描述成端到端加密的。** 目前不是。对象存储与 Postgres 对服务方可见。如果要真 E2E，那是一个独立立项（含密钥分发），与知识库那边是同一个结论。

---

## 32. 附录 G：会话搜索与引用

搜索有两种：

**会话列表搜索。** `session-search-dialog.tsx` 在当前会话集里按标题/预览搜。它不需要全文索引。

**消息搜索。** 目前没有全局消息全文搜索。知识库的 RAG（如果有）索引的是知识库，不是聊天记录。用户想找「上周 AI 说的那个方案」，目前只能靠会话名、时间、和手动翻。

这是一个真实的能力缺口，写文档时不应该回避。它的难点不在搜索本身，而在「聊天记录要不要变成可检索资产」这个产品定位问题——《team-knowledge-base-program.md》明确说「聊天是过程，知识库是结论」，也就是说，**搜索聊天记录不是一个默认要支持的能力**，否则大家会一直从过程里找结论，而不去沉淀。

引用则是另一个方向：`AgentReplyQuote.tsx` 让人把 agent 的某句话作为上下文带回。它服务的是「接着这句话讨论」，而不是「找到这句话」。

---

## 33. 附录 H：变更记录与维护

本文写于当前 `main`。以下变动会要求同步更新：

| 变动 | 影响章节 |
|---|---|
| 未读徽标实现 | 第 7、30 节 |
| 参与者缓存失效补上 | 第 7.1 节 |
| 流式不再是单一 reconcile | 第 4 节（重大） |
| 线程不再是独立 session | 第 6 节（重大） |
| MQTT QoS 改变 | 第 5.2 节 |
| 全局消息搜索上线 | 第 32 节 |
| 会话 E2E 加密 | 第 31 节（重大） |
| 双 store 遗留层清理 | 第 2.3 节、第 1 篇 |

写本文时最容易犯的错是把它写成一篇「聊天功能的产品说明」。它不是。它的重点是那些**看起来多余、实际是必需**的机制：单一 reconcile 点、业务事件不丢、状态变化可见、发送路径可见。这些东西在正常时候都不显眼，出了问题才看得出来。

---

## 34. 一个总结：会话的三个不变量

如果把整篇压缩成三条，是这些：

**一、单一来源。** 流式与最终内容只有一个 reconcile 点，且守卫测试守着它。原因是「两个源写同一个字段」必然导致跳变，而这类 bug 极难复现、用户却立刻察觉。

**二、业务事件不丢。** delta 丢一两帧无所谓，消息不能丢。所以传输用 QoS0 但不代表可以静默丢消息，历史重拉是兜底。

**三、状态变化可见。** agent 换了、模型换了、权限模式变了，都要有一条 notice。否则用户会把「行为变了」理解成「AI 变笨了」，然后开始不信任它。

这三条都不是「更好的工程实践」，而是对三个具体失败模式的回应：跳变、丢消息、静默变化。它们也是这块文档里最容易被新接手的人跳过的部分——因为它们看起来像瑣碎的实现细节，而不是设计。

最后一个与第 2 篇共享的结论：**会话是一等对象，消息只是它的事件。** 参与者、权限、runtime 绑定、来源、生命周期都围绕会话，而不是围绕消息。理解这一点，就不会把会话当成「消息的容器」。

---

## 35. 附录：会话数据的生命周期

会话里的每一类数据都有自己的生命周期，而它们并不一致。理解这个不一致，是排查很多问题的前提。

### 35.1 消息

- 写入：在线直写云，离线走 outbox；
- 读取：打开会话时补拉 + 实时订阅；
- 保留：长期（除非会话归档）；
- 本地：libsql 缓存一份。

消息是永久数据。一点丢失就是真的丢了，所以它是唯一不允许静默失败的类别。

### 35.2 流式内容

- 写入：delta 进入缓冲，按帧构建显示；
- 读取：从 v2 stream store；
- 保留：**只在当前 turn 的生命周期内**；
- 完成：由唯一 reconcile 点写进消息。

流式内容是最短命的。它的存在意义就是「在最终内容还没来时先显示」。一旦完成，它的值就不重要了——重要的是与最终内容对齐。

这个短命性解释了两件事：为什么 delta 可以丢（下一帧会补上），以及为什么不能用它作为任何持久判断的依据（它随时会消失）。

### 35.3 参与者

- 加载：懒加载；
- 失效：**目前不会自动失效**（已知缺口）；
- 用途：头像、成员列表、remote-tools 校验的前提。

参与者缓存的「不失效」是这块唯一一个已知会直接导致用户看到陈旧数据的地方。它的影响面比看起来大：remote-tools 的 fail-closed 校验要求 participants 已加载，如果缓存里是一个空列表，校验会拒绝本应放行的请求。所以 `ensureParticipants` 会在冷或「被空缓存污染」时重新拉。

### 35.4 在线状态

- 来源：MQTT `actor/state`；
- 粒度：actor 级（不是会话级）；
- 保留：内存。

在线状态是短命的且不需要持久化。它只影响展示（绿点/珊瑚点）。

### 35.5 notice

- 写入：系统事件（agent 替换、模型切换、权限模式变）；
- 读取：会话内列表；
- 保留：随会话。

notice 是最容易被忽视的一类数据，但它是「状态变化可见」这条原则的唯一载体。

### 35.6 生命周期不一致带来的实际问题

因为六类数据的生命周期不同，一个看似简单的问题会变得复杂：**「刷新这个会话」到底应该刷什么？**

- 刷消息：拉历史 + 订阅；
- 刷参与者：重新拉 Cloud API；
- 刷流式：通常不该动（可能有一个 turn 在跑）；
- 刷在线：等 MQTT 事件；
- 刷 notice：跟会话一起。

**没有一个单一的「刷新」能包括全部，且某些刷新是危险的**（刷流式会把正在生成的内容清掉）。这是为什么会话开关时会有一系列分别的加载，而不是一个统一的 reload。

一个实用的建议：遇到「界面不对」时，先分清是哪一类数据陈旧，再决定怎么刷。用错了刷新路径会看起来「刷新了但还是不对」，或者更糟——把正在跑的内容清掉。

---

## 36. 附录：为什么会话是团队级的

会话归属团队（`sessions.team_id`）而不是个人，这个选择影响了很多事，值得单独想清楚。

### 36.1 表面理由

团队协作需要多人看同一个会话。如果会话是个人的，「拉队友进来」就要做一次数据复制或授权，而这两种都会带来一致性问题。

### 36.2 更深的理由

**agent 是一个团队资产，不是个人工具。** 一个会话里绑定的 agent 属于某个 actor，而这台设备上的 agent 服务的是团队。所以会话天然是团队的。

这条也解释了为什么「同一 user 同一 team 只能有一台 Desktop 在线」（ADR-0002/0006）：agent 身份是团队级的，两台机器就是两个身份，而两个身份就不能共享同一个会话的上下文。

### 36.3 与个人/私有的边界

有一些东西确实是个人级的：

- 模型偏好（`agent-model-pick-store`）；
- 离线发送偏好；
- 本机路径与 workspace；
- 各人已安装的技能。

这些不影响会话的团队性，因为它们是「本机的展示/行为偏好」，而不是「会话里的内容」。一个人把模型切成 A、另一个人切成 B，他们在同一个会话里看到的还是同一批消息。

### 36.4 一个反直觉的推论

因为会话是团队级的，**「删除会话」是一个团队动作。** 一个人删了，所有人都看不到。这与「文档库是团队级的，删文件是团队动作」一致，也是为什么删除会话需要确认。

同样地，会话的归档、置顶、高亮都有一层「这是看到它的人共同的状态」的语义。有些状态（置顶）在各人之间可能不一致——那是接受的，因为它们是视图偏好而不是内容。

### 36.5 与知识库、app 的对比

| 对象 | 团队级？ | 为什么 |
|---|---|---|
| 会话 | 是 | agent 是团队资产，协作单元 |
| 知识库 | 是 | 团队共识 |
| 技能 | 是 | 团队规范 |
| app | 是 | 团队部署目标 |
| 模型偏好 | 否 | 本机行为 |
| 已装技能 | 否 | 本机磁盘 |

这张表可以用一句话总结：**内容与能力是团队的，行为与磁盘是个人的。** 新增一个状态时，先回答它属于哪一类，就能知道它要不要跨设备同步。

---

## 37. 附录：这块文档的阅读路径

如果你刚接手，建议按这个顺序读，并同时打开对应代码：

1. 本文第 1–3 节，建立「会话是一等对象」的直观；
2. `CLAUDE.md` 的 Streaming Architecture，流式规则只有几条但必须记住；
3. `lib/agent/agent-reply-transcript.ts`，唯一的 reconcile 点；
4. `stores/v2-stream-parts.ts`，看流式状态；
5. `components/chat/ChatMessage.tsx`，看消息如何分发；
6. `MqttLiveWiring.tsx`，看实时如何接线；
7. 本文第 6 节，线程；
8. 本文第 9 节，权限与提问。

不建议一开始读 `ChatPanel.tsx`（组装层）与 `session-store.ts`（遗留层）。前者会在没有上下文时看起来无比庞大，后者会让你以为双 store 是设计而不是待清理的技术债。

一个具体提醒：**读完不要试图「统一」流式与最终内容。** 那个统一已经发生过一次，它的名字叫 reconcile 点。任何「更智能地合并两者的内容」的想法都会被 `agent-reply-single-reconciliation.test.ts` 拦住，而那个测试是对的。

---

## 38. 附录：一个可以复用的判断

这篇的核心判断可以压缩成一句：**「这个数据是过程还是结果？」**

- 过程（流式 delta、在线状态、runtime 状态）：可以丢、可以降级、可以陈旧；
- 结果（消息、参与者、会话）：不能丢、不能降级、陈旧就是 bug。

这条判断直接决定了它们的传输与保留策略：过程用 QoS0、内存、可丢；结果用可靠写入、持久化、历史重拉兜底。

它也解释了为什么「流式与最终内容必须分开」：它们是过程与结果两类数据，混在一起就会让结果被过程的丢失影响。

一个实用的方法：新增一个数据时，先回答它属于哪一类。属于过程的，不要为它做持久化；属于结果的，不要让它走不可靠的通道。两者搞反会同时得到「存了一堆没用的中间态」与「丢了重要的东西」。

---

## 39. 附录：这块的三条历史教训

把这篇里提到的历史问题集中列一遍，它们比任何设计原则都更能让人记住为什么代码长成这样。

**一、多源合并必然跳变。** 流式与最终内容曾经可以互相写，结果是「完成瞬间文字变了」。修法不是「更小心」，而是单一 reconcile 点 + 守卫测试。

**二、业务消息静默丢不可接受。** delta 可以丢，消息不行。所以有历史重拉与 outbox，而不是「反正 MQTT 会重发」。

**三、状态变化不说话会被误读为「AI 变笨」。** 所以有 notice、有横幅、有各种看起来多余的状态展示。它们不是装饰，是「用户对系统的信任」的基础设施。

三条的共同点：**它们在正常时候都不显眼，出了问题才看得出来。** 这就是为什么这块需要一份单独的文档——因为新接手的人容易把「正常时候用不到的东西」当成可以删的东西。

---

## 40. 附录：三句话的速记

1. 会话是一等对象，消息只是它的事件。
2. 内容只有一个来源，业务事件不能丢。
3. 状态变化要说出来，否则会被当成变笨。

---

## 41. 附录：读完这篇应该能回答的问题

- 为什么流式期间不能写 `msg.content`？因为那会造出第二个内容来源，导致完成瞬间跳变。
- 为什么 delta 可以丢而消息不能？因为 delta 是过程，消息是结果，且结果有历史重拉兜底。
- 为什么线程是一个新会话？因为它需要独立身份，否则列表、置顶、活动全算错。
- 为什么参与者缓存不会自动失效？因为 realtime handler 还没接上——这是一个已知缺口，不是设计。
- 为什么通知走 inbox 而不是订阅所有会话？因为订阅所有会话在会话多时不可行。

五个问题里有四个是「过程与结果的区别」，一个是「已知缺口」。把两者分清，就能避免把缺口当成设计。

---

## 42. 附录：最后一点：为什么这块值得单独一篇

会话是用户接触最多的东西，也是最多看起来「没什么设计」的东西。但正是这种「看起来简单」让人容易把它当 Chat App 来做，而一旦当 Chat App 做，就会丢掉三样东西：**会话作为协作单元的身份、流式的单一来源、状态变化的可见性。**

本文的每一节都在守护其中一样。读完之后，希望你能在写下一行代码前先问一句：我改的是消息，还是会话？

---

## 43. 附录：三句话的速记（终）

把整篇最后压成三句：**会话是一等对象；过程与结果分开；状态变化要说出来。**

三句分别对应本文的三条不变量，也对应三处最容易退化的地方：把会话当消息容器、把流式与最终内容合并、把 agent/模型切换做成静默。守住这三句，这块就不会回到 Chat App 的样子。

另外记住一条事实：参与者缓存不会自动失效，这是已知缺口而不是设计。

---

## 44. 结语

会话这块的复杂度集中在两处：**流式的单一来源原则**，和**实时与持久化的一致性**。前者靠一个 reconcile 点 + 守卫测试锁死，后者靠业务事件不丢 + 历史重拉兜底。剩下的功能（线程、权限、提问、token 用量）都是围绕「会话是一等对象」这个定位长出来的：它们都不是消息的装饰，而是会话作为协作单元的能力。
