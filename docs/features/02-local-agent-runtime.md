# TeamClu 功能详解 · 第 2 篇：本地 Agent 运行时（amuxd + pi）

> 版本基线：当前 `main`（`package.json` v0.4.1-beta.51）。
> 读者：要接手 daemon / agent 这块的工程师。
> 关联：ADR-0002、ADR-0004、ADR-0006、ADR-0007、ADR-0014、ADR-0015、
> `docs/architecture/pi-agent-backend.md`、`docs/architecture/agent-backend-discovery-and-advertise.md`、
> `docs/architecture/agent-device-reachability-and-runtime-ensure.md`。

---

## 0. 一句话定位

`amuxd` 是 TeamClu 的**本地 agent host**。它不渲染任何 UI，只做四件事：把 pi 跑起来、把 agent 的话翻译成协议消息、把外部世界（通道网关）的输入喂给 agent、把团队内容同步到本地。装 TeamClu Desktop 会同时装它，所以「本机即 agent host」开箱成立；它也可以作为独立 CLI 装在服务器上，没有 GUI。

理解这块的关键是接受一个反直觉的前提：**agent 不属于客户端，属于 daemon。** 客户端只发「起一个会话」「发送这条消息」这样的意图，daemon 决定用什么进程、什么工作区、什么模型去执行。这解释了为什么 iOS / Expo 上没有本地 agent——不是「还没做」，是那些端没有 daemon。

---

## 1. 为什么要有独立进程

把 agent 塞进桌面 app 进程里是可行的，早期也许就是这么做的。但走到 v2 之后必须拆开，有三个绕不开的理由：

**第一，agent 的价值在于「人不在的时候也在」。** 定时任务、通道消息触发的回合，都需要一个不受 GUI 生命周期影响的宿主。如果 agent 跑在桌面进程里，关掉窗口 agent 就死了，那「让 AI 帮你盯着」就彻底不成立。

**第二，一台机器可以有多个客户端形态，但只能有一个 agent 身份。** v2 的约束是「同一 user 同一 team 只能有一台 Desktop 在线（= 一个 daemon = 一个 agent 身份）」。把 agent 放在 daemon 里，这个「一个身份」才有地方落。放在客户端里，两个客户端就会变成两个身份。

**第三，协议稳定性。** 客户端（Tauri / iOS / Expo）更新节奏不同，而 agent 的对话语义必须一致。daemon 是唯一实现 ACP 语义的地方，各端只是它的消费者。这也让「事件出口统一为 `amux.AcpEvent`」这件事成立——gateway、MQTT、前端、iOS 全部零改动。

---

## 2. 三层拓扑

```
客户端（Desktop / iOS / Expo / Extension）
        │  HTTPS（Cloud API）+ MQTT（EMQX）
        ▼
   TeamClu Cloud API (/v1)        identity / teams / sessions / messages
        │
   amuxd daemon                   agent host + channel gateways + team sync
        │  stdio JSONL / HTTP
   pi 本地 agent
```

三条链路要分清：

- **业务数据**（会话、消息、团队）走 Cloud API；
- **实时**（消息、在线、RPC）走 MQTT；
- **agent 执行**（起 runtime、发 prompt、权限审批）走客户端 ↔ daemon 的 HTTP/RPC。

第四条容易被忽略：**团队同步完全由 daemon 负责**，客户端只是触发器和展示器。所以关掉 app 后同步继续跑。这一点在第 4、5 篇展开。

---

## 3. pi 是唯一运行时（ADR-0014）

2026-09-04，owner 决定 daemon 只运行 pi。被删掉的东西列出来能说明这个决定的重量：

- `agents.local_agent` 配置位与 `build.config.localAgent`；
- `agent_discover` 与 `runtime_resolution` 的四路分发；
- `create_backend()` 的工厂 match；
- 设置页与首启向导里的 runtime 选择；
- doctor 里 opencode / cursor / claude 三行；
- `runtime/` 里约 14K 行随 copilot361 进来的 sidecar 代码。

决策理由（ADR-0014 原文）：四个后端的代价是一个 17 参数的 `attach_session`、四份命令循环，以及「每个客户端都在替 daemon 猜 agent_type 再被 daemon 用配置推翻」。而 pi 已经具备单后端所需的全部能力：多会话 host、MCP 桥、permission、AnswerQuestion、fork、team provider。

**`AgentType` 枚举保留了。** 因为存量数据里到处是它（`agents.default_agent_type`、`agent_types`、cron job、iOS / Expo 的 picker 值）。daemon 对任何非 `PI` 的输入在**一处**（`daemon/runtime_resolution.rs`）打一条 warn 后按 pi 跑，不拒绝——拒绝等于让每个 `default_agent_type = 'opencode'`（今天的大多数）的 agent 在升级后全挂。`team.toml` 里的 `local_agent` 读到即忽略、存盘时原样保留，给降级留路。

**代价要认**：存量 opencode 会话的 `backend_session_id` 没有 `pi:` 前缀，resume 时新开 pi 会话绑回同一个 TeamClu session：聊天记录在云端不丢，agent 的上下文记忆丢。这是一个明确接受的产品代价，不是 bug。

这条 ADR 的真正含义是：**TeamClu 不再是一个「多 runtime 编排器」，而是一个「pi 的产品化外壳」。** 任何让 daemon 支持第二种 runtime 的提案，都要先推翻 ADR-0014。

---

## 4. amuxd 托管 Node 与 pi（ADR-0015）

ADR-0014 之后紧接着一个安装问题：pi 需要 Node，而「每个 pi 装了但起不来」最后都是**哪个 Node**：

- GUI 进程读不到 `~/.zshrc`，nvm / fnm / n / volta 装的 Node 看不见；
- Windows 从不修复 PATH，装完 Node 要重启机器才可见；
- 一台机器三个 Node，终端说 24、app 说 20（#1049、#1232）；
- `npm` 在 Windows 是 `npm.cmd`，Rust 的 `Command::new("npm")` 永远找不到（#1046）。

这些全是在猜用户的 Node。opencode 是单二进制，所以首启向导「什么都不用你装」以前是真的；换成 pi 后，guided 路径遇到 Node 缺 / 旧就停下来让用户手装——**托管 Node 是让「零手动」重新成立的唯一办法**。

ADR-0015 的结论：pi 运行时 = 钉版的 Node.js 发行包 + pi npm 包 + `@modelcontextprotocol/sdk`，三者由 amuxd 自己装在自己的目录里，路径是常量：

```text
<amuxd cache>/node/<version>/            官方发行包原样解压（含 npm）
<amuxd cache>/pi/
  package.json  package-lock.json        从 apps/daemon/pi-runtime/ 物化
  node_modules/@earendil-works/pi-coding-agent/   ← package root
  node_modules/@modelcontextprotocol/sdk/
  extensions/teamclu.ts                  ← 裸 import 沿目录向上解析到上面的 node_modules
  host/host.mjs
```

安装 = 下载 Node 归档（校验 SHA-256）+ `node npm-cli.js ci`。**不经 `npm.cmd`、不经 cmd.exe、不读 PATH、不碰 `~/.pi` 与用户的全局 npm。** 开发者要换 Node 或 pi 用 `[agents.pi] node = / package_root =`——那是显式路径，不是搜索。

版本单一来源：`apps/daemon/pi-runtime/package.json` + `package-lock.json` 钉 pi 与 SDK，`pi.lock.json` 重复这两个值（给镜像 workflow 与 doctor 用）并钉 Node；一个单测守住三者一致。

下载路线按实测吞吐选：官方 → npmmirror 公共镜像 → 自建 OSS。Windows 先试预打包的 `node + pi + sdk` 归档：一次下载一次解压，不跑 npm。

**后果**：

- `resolve_node` / `node_manager_dirs` 的 best-of-N 启发式、`resolve_pi_package_root` 的符号链接回溯、`~/.pi/bin` 查找全部不再是 pi 的路径；
- 首启流程变成 Language → 登录 → daemon wizard（start-daemon → install-runtime → mint-invite → …），runtime 在登录后、绑定后安装，daemon 的 doctor 是唯一真相，没有 `setup-ok` 缓存；
- pi 上游抬 `engines.node` 时由我们的 lock 决定何时跟，pi 与 Node 一起发；
- 官方 Node 二进制要 glibc ≥ 2.28，老 CentOS / musl 上 doctor 直接报不满足；
- 代价是每台机器多约 100MB 磁盘，每次 Node 钉版多 6 个归档进 OSS。

---

## 5. 进程 / 会话模型：Host 与 LegacyRpc

pi 子进程有两种模式（`apps/daemon/src/runtime/pi_rpc/process.rs`）：

### 5.1 Host（默认）

`node <cache>/pi/host/host.mjs` —— TeamClu 自带的**多会话 host**，随 amuxd 分发（`include_str!` 物化），进程内跑 N 个并发 `AgentSession`（pi npm 包的 SDK 入口）。

协议仍是 stdio JSONL，但**每条命令和每条事件都带 `sessionId`**，同 worktree 的多个会话可以并发 prompt / 流式 / cancel 互不影响。extension、MCP 桥、model registry 在进程内共享——会话数增长不重复付 MCP 冷启动和基础内存。

### 5.2 LegacyRpc（回退）

`pi --mode rpc`，单活动会话协议（命令/事件不带 session 标识，`switch_session` 会销毁在跑的 turn，因此有 mid-turn 守卫，第二个会话发消息会被拒绝重试）。

两种情况走这条路：pi 装的是 Bun 单二进制（解析不到可 import 的 npm 包根目录），或 `daemon.toml` 里 `[agents.pi] session_host = "rpc"`（一键回退开关）。

### 5.3 进程池键

**进程池键 = `(isolation domain, process-env revision, canonical worktree)`。**

这个三元组值得解释。它对齐 opencode 的 host pool 维度；此前只按 worktree 分、env 池全局 first-wins，结果 workspace A 的 env 会粘进 B 的进程——这是一个真实存在过的串味 bug。加上 env revision 之后，环境变量变了就换进程。

会话文件仍只按 worktree 散列到 `<state>/pi-sessions/<hash>/`——**resume 不受 env 变更影响**。这个区分很重要：进程是按环境池化的，会话是按工作区持久化的，两者不绑在一起。

### 5.4 会话上限

每个 host 有**软上限 8 个常开会话**，超出按 LRU `close_session`（route 保留，下次 prompt 重开）。这是内存与冷启动时间的折中：常开太多会吃内存，全关又每次冷启动。

---

## 6. `runtime/pi_rpc/` 的四个组件

| 组件 | 职责 |
|---|---|
| `process.rs` | 进程池（键 = domain + env revision + worktree），Host/LegacyRpc 模式解析（npm 包根目录探测 + `[agents.pi] session_host` 配置），host.mjs / extension 物化，env 注入，kill_on_drop，崩溃后惰性重启 |
| `client.rs` | JSONL 命令写入 stdin（带 `id` 关联 response）：`open_session` / `new_session` / `close_session`、`prompt`（含 `streamingBehavior`）、`abort`、`set_model`、`get_available_models`、`get_state`、`get_entries since`、`get_commands` |
| `events.rs` | stdout 逐行解析（仅按 `\n` 切分），按事件 `sessionId` 路由（Legacy 回退到 active session）；未知 sessionId 丢弃不影响他会话；EOF 时结算该进程全部在跑 turn 并尝试 `get_entries since` 回补；`extension_ui_request` 的 confirm→权限、带标记的 select→question |
| `translate.rs` | `message_update.assistantMessageEvent`: `text_delta`→Output、`thinking_delta`→Thinking；`tool_execution_start`→ToolUse、`_end`→ToolResult（isError 映射）；`agent_end`→回合完成 StatusChange；`extension_error`→AcpError；`replay_entries`（崩溃回补去重重放）；question 标记解析 |

host 侧（`assets/pi-host/host.mjs`）只实现 daemon 真正用到的命令面，协议在文件头注释里；契约测试在 `tests/pi_host.rs`（stub SDK：`tests/fixtures/pi-host-stub/`，无网络无真 pi，验证并发、事件归属、per-session abort、UI 归属）。

**为什么 host 是自带的而不是用 pi 的原生 serve？** 因为需要多会话、需要把 UI 交互（权限、question）归属到正确的会话、需要崩溃回补。pi 原生的 rpc 模式做不到这些，所以 TeamClu 自己写了一个薄 host，把 pi 的 SDK 包起来。这也是为什么版本锁这么重要——host.mjs 依赖的是 SDK 的具体 API。

---

## 7. 权限审批：pi 没有内建权限

这是 pi 与 opencode 最大的差异点。opencode 内建 `permission.asked` / reply 端点；**pi 没有**。

TeamClu 的方案：随 daemon 分发一个 **TeamClu pi extension**（TS 单文件，安装到 `--extensions` 路径）：

1. extension 钩住全部工具执行（bash / edit / write 等）；
2. 按 TeamClu workspace 权限规则（daemon 通过 env / 配置文件传入）决定放行或询问；
3. 需询问时调 `confirm` dialog → pi 发 `extension_ui_request{method:"confirm"}` 到 stdout → `pi_rpc/events.rs` 翻译为 `AcpPermissionRequest`（request_id = ui request id）→ 走既有 UI 审批 → `ResolvePermission` → 写回 `extension_ui_response{confirmed}`；
4. **gateway 会话**（`is_gateway`）由 daemon 直接自动应答 `confirmed=true`。

「始终允许」语义在 extension 内记忆（per session / workspace 规则文件）。

前端侧对应的是 `PermissionCard`、`PermissionApprovalPanel`、`PermissionApprovalModeSelect`、`PendingPermissionInline`、`PermissionWaitingBanner`，以及 `lib/teamclu/reply-acp-permission.ts`、`handle-acp-permission-request.ts`、`flush-session-pending-permissions.ts`。

一个产品层面的设计：**权限卡片的呈现由 `permission-presentation.ts` 决定**，而不是每个调用点自己拼。这样「同样的权限请求在任何入口看起来一样」是有保证的。

---

## 8. MCP：pi 官方不做，extension 自己做客户端

pi 的 README 明确写着「**No MCP.** … or build an extension that adds MCP support」。所以 **TeamClu extension 本身就是 MCP 客户端**，基于官方 `@modelcontextprotocol/sdk`。

关键设计：

- **服务器清单同源**：仍是 workspace `opencode.json` 的 `mcp` 表（团队 + inherent + 用户三处合并的 SSOT）。daemon 的 `pi_server_spec`（`pi_rpc/mod.rs`）把它归一成两种形状塞进 `TEAMCLU_MCP_SERVERS`：`{type:"local", command, environment}` / `{type:"remote", url, headers}`。`amuxd-remote-tools` 走自己的 `TEAMCLU_REMOTE_TOOLS_CMD`（要带 socket 参数）。
- **两种 transport 都支持**：local 走 `StdioClientTransport`，remote 先试 streamable HTTP，被拒再退 SSE——与 opencode 原生加载的集合对齐。
- **SDK 带来的能力**：`tools/list` 翻页、`notifications/tools/list_changed` 运行时增量注册、`AbortSignal` 透传取消、image 结果按 `ImageContent` 原样回传。
- **进程内共享**：bridge 注册表挂在 `globalThis`，按 (label, spec 签名) 复用；`tools/list` 结果落盘缓存（`TEAMCLU_MCP_TOOL_CACHE_DIR`），冷启动不必等最慢的那个 npx server。config 文件有 watcher，改 `mcp` 表无需重启 pi。
- **工具名**：默认原样注册，只有真撞名才给后来者加 `<server>_` 前缀，先到先得。

**安装**：SDK 不是可选项——没有它就没有 remote-tools、没有任何团队工具。`pi_install::mcp_sdk` 把 `@modelcontextprotocol/sdk` 装进 extension 物化目录（`<cache>/pi/extensions/node_modules`，pi 会从 extension 同级目录解析裸导入），版本与 pi 一起锁在 `apps/daemon/pi.lock.json` 的 `mcpSdkVersion`，并计入 `doctor().satisfied`。官方 registry 不通时退到 OSS 镜像。

extension 里的 import 是**动态且带 try/catch** 的：SDK 缺失只损失 MCP 工具，**权限门与 question 工具照常工作**。这个降级设计很重要——它保证「MCP 装不上」不会变成「agent 完全不可用」。

---

## 9. 模型与 provider 认证

### 9.1 模型

pi 配置文件（`~/.pi/agent/` 或 `--config`）里 `registerProvider` 指向 LiteLLM 网关（`openai-completions` API）。已知坑：需设 `compat.supportsDeveloperRole=false` 与 tool schema 清洗（`onOpenAICompletionsCompat`），否则严格网关会拒绝请求。`get_available_models` → `AcpStartupMetadata.available_models`。

ADR-0007 的结论是：**amuxd 持有模型能力，不持有模型偏好。** 也就是说 daemon 知道「有哪些模型可用」，但「这个会话用哪个」由客户端决定并传下来。这条区分让多端可以各自记住自己的模型选择（前端有 `agent-model-pick-store`）。

### 9.2 Provider 认证（`pi /login`）

pi 的凭证在 `~/.pi/agent/auth.json`、自定义 provider 在同目录的 `models.json`，两者都只能经 pi SDK 的 `ModelRuntime` 访问。所以设置页的 provider 面板**不是自己实现一套登录**，而是把 pi 的 `AuthInteraction` 接口投影到线上：

```
设置页 ──HTTP──> amuxd ──JSONL──> host.mjs ──> ModelRuntime.login()
  /v1/pi/*        pi_auth.rs      auth_* 命令      （pi 自己的实现）
```

几条实现约束值得记：

- **host.mjs 新增的命令**：`auth_list` / `auth_login_start` / `auth_login_cancel` / `auth_logout` / `auth_refresh` / `auth_models_{get,put,delete}`，并把 pi 的 `prompt(AuthPrompt)` 与 `notify(AuthEvent)` 发成 `auth_prompt` / `auth_event` 事件，答案经 `auth_prompt_response` 回灌。
- **登录是「先 ack 再事件」**：浏览器往返远超 `PiClient` 的 30s 请求超时，一问一答的形状会把 pi 还在跑的流程丢掉。`auth_login_start` 立刻 ack，流程用 `loginId` 关联，结束时发 `auth_login_end`。
- **`runtime/pi_rpc/auth.rs` 是进程级 login 注册表**，存着该流程所在子进程的 `PiClient`：应答提示词直接写那个子进程的 stdin，不必去抢 backend 锁（抢了会和「只有回答提示词才能释放的登录」互相死锁）。
- **`auth_*` 事件不带 `sessionId`**，必须在 `events.rs` 的 session 归属逻辑**之前**截获，否则会被算到「当前活跃会话」头上，把登录提示投进聊天里。
- **provider 列表、认证方式、提示词文案全部来自 pi**：这边没有任何 provider 分支。
- **`models.json` 是整篇读改写**：只替换目标 provider，其余键原样保留；写完调 `ModelRuntime.refresh()`，同一子进程内即时生效。
- **HTTP 状态区分**：子进程答复并拒绝是 422，取不到 host 是 503。

---

## 10. Runtime 可达性与 ensure

agent 不是「一直在线」的。`lib/agent/` 与 `lib/teamclu/` 里有一整套「确保 runtime 在跑」的机制：

- `ensure-agent-runtime.ts`：给定会话，确保对应的 agent runtime 存在；
- `runtime-ensure-scheduler.ts`：定期检查哪些 runtime 应该在线；
- `agent-device-reachability-and-runtime-ensure.md`：设计文档；
- `runtimeStates` / `availableCommands`：前端看到的运行时状态与可用命令列表；
- `EngagedAgentOfflineBanner` / `session-agent-probe.ts` / `session-agent-stale-binding.ts` / `session-agent-ui-state.ts`：前端如何表达「agent 现在不可用」。

一个关键概念是 **agent 与 device 的绑定**：一个 agent 属于某个设备（daemon）。设备离线，agent 就离线。前端不是通过心跳判断，而是通过 daemon 注册的 runtime 状态。

---

## 11. 会话、fork 与崩溃恢复

### 11.1 会话文件

pi 的会话持久化在 `<state>/pi-sessions/<worktree-hash>/`，append-only JSONL。daemon 维护 `runtimes.toml` 里的绑定（TeamClu session ↔ pi session）。

### 11.2 Fork（线程）

`docs/architecture/session-threads.md`：只有 **agent_reply** 消息能开线程。线程是一个**新的云会话**（`source=thread`）带 `parent_session_id` + `thread_root_message_id`，从主会话列表隐藏。

Pi 后端的 fork 是**懒 fork**：第一次 `runtimeStart` 时：

1. 客户端发 `RuntimeStartRequest.fork_from { parent_session_id, root_message_id }`；
2. daemon 读父 `runtimes.toml` 绑定 + anchor 消息的 `metadata.backend_session.fork_point.pi_leaf_id`；
3. Pi host `fork_session` → `SessionManager.createBranchedSession(leafId)` → 新的 `pi:/path.jsonl`；
4. 线程 runtime 用 `resume_acp_session_id` 附着，并带 `forbid_new_session_fallback`。

### 11.3 崩溃回补

子进程崩溃后，按 route 记录的 leaf id 调 `get_entries since` 回补未见尾部（`events::backfill_and_close`）。EOF 时结算该进程全部在跑 turn，然后尝试回补。这是「agent 进程挂了但聊天记录不丢半截」的实现。

---

## 12. 部署形态与 doctor

amuxd 有两种形态：

1. **随桌面安装**：由安装器注册为 companion service，自动起停；`apps/desktop/` 里有 supervisor 逻辑。
2. **独立 CLI**：服务器 / headless 场景，没有 GUI。gateway 场景、cron（在没有桌面时）都靠它。

`doctor()` 是安装与健康检查的唯一真相：检查 Node 版本、pi 版本、SDK 版本、各依赖是否满足。首启向导不缓存 `setup-ok`，每次 refresh 都问 doctor——**因为机器的状态会变**（用户卸载了 Node、公司 IT 推了新的 PATH）。

诊断相关：`DiagnosticSymptomPanel`、`lib/diagnostics/`、`DiagnosticsSection`。daemon 的状态也可以通过 `daemonGeneral` / `daemonWorkspaces` / `daemonRuntimes` 设置页查看。

---

## 13. 安全与隔离

几个边界：

- **workspace 隔离域**：进程池键的第一个维度。不同 isolation domain 不共享进程。
- **env revision**：环境变量变更换进程，避免串味。
- **canonical worktree**：同一个工作区用规范路径，避免符号链接导致的「两个进程跑同一个目录」。
- **gateway 会话自动批准权限**：这是无人值守场景的必需，但有明确前提（`is_gateway`）。
- **PTY 的 allowed roots**：终端 cwd 必须在被允许的根下，由前端传，没有根就没有终端。
- **introspect API 的 bearer token**：`127.0.0.1:13144` 的 loopback HTTP 服务有 per-launch bearer token，模块头注释记录了 token 文件与拒绝规则。

ADR-0009 定了 webview 的文件系统与网络作用域，ADR-0013 要求 IPC 错误带 code。这两条都影响 daemon 与前端之间的错误表达。

---

## 14. 测试

- `tests/pi_host.rs`：host 协议契约测试，用 stub SDK，无网络无真 pi。覆盖并发、事件归属、per-session abort、UI 归属。
- `apps/daemon` 的单元测试：`pnpm daemon:test` / `node scripts/daemon-cargo.js test`。
- 端到端：`tests/v2-e2e/` 通过 tauri-mcp 驱动真实 app。
- translate 层用文档 JSON 样例喂，确保 pi 事件到 `AcpEvent` 的映射不漂移。

**风险**（`pi-agent-backend.md` §6）：pi 破坏性变更频繁（两月 31 版、npm scope 迁移、v0.80 API 重构），所以必须版本锁 + CI 里用锁定版本跑 translate 契约测试。权限 / MCP 全靠自带 extension，extension API 本身也可能变，所以 extension 随 daemon 版本捆绑发布，不追 pi 上游生态。上游是单维护者，必要时轻量 fork（只做 compat 修补）。

---

## 15. 关键文件索引

```
apps/daemon/src/
  runtime/backend.rs              AgentBackend trait
  runtime/manager.rs              RuntimeManager
  runtime/pi_rpc/mod.rs           PiRpcBackend、pi_server_spec
  runtime/pi_rpc/process.rs       进程池
  runtime/pi_rpc/client.rs        JSONL 命令
  runtime/pi_rpc/events.rs        事件解析与路由
  runtime/pi_rpc/translate.rs     事件翻译
  runtime/pi_rpc/auth.rs          login 注册表
  runtime/turn_aggregator.rs      回合聚合
  runtime/permission_policy.rs    权限策略
  runtime/team_skills.rs          共享 agent 侧 skills 对账
  daemon/runtime_resolution.rs    唯一的 agent_type 归一化点
  daemon/server/cron.rs           cron turn 执行
  daemon/prompt_await.rs          prompt-await 协议
  config/global_team_store.rs     团队内容根
  sync/                           OSS 同步
  channels/core/                  通道内核
  assets/pi-host/host.mjs         多会话 host
  extensions/teamclu.ts           权限门 + MCP 桥
  pi-runtime/package.json         版本单一来源
  pi.lock.json                    Node/pi/SDK 锁
apps/desktop/src/                 supervisor、IPC
packages/app/src/lib/teamclu/     前端侧 ACP 协议处理
packages/app/src/lib/agent/       agent 身份与模型
packages/app/src/lib/daemon/      对 amuxd 的调用
```

---

## 16. 常见坑

1. **不要在客户端 spawn agent。** 只发 `RuntimeStartRequest`。
2. **AgentType 枚举不能删。** 存量数据依赖它；非 PI 输入打 warn 后按 pi 跑。
3. **不要新增第二种 local runtime。** 先推翻 ADR-0014。
4. **不要探测用户机器上的 Node。** 用托管的。
5. **进程池键是三元组。** 少了 env revision 会串味。
6. **`auth_*` 事件要在 session 归属之前截获。** 否则登录提示会进聊天。
7. **MCP SDK 缺失要降级而不是崩。** 权限门和 question 必须还能用。
8. **gateway 会话自动批准权限是有前提的**（`is_gateway`），不要把这个默认值扩散到普通会话。
9. **改 pi 版本要同时改三处**（`pi-runtime/package.json`、`package-lock.json`、`pi.lock.json`），有单测守着。
10. **`translate.rs` 的映射要有契约测试。** pi 会变。

---

## 17. ACP 协议：daemon 与 pi 之间的语义层

ACP（Agent Client Protocol）不是一个网络协议，而是 TeamClu 内部的一套**语义约定**：daemon 把 pi 的原生事件翻译成 `amux.AcpEvent`，所有下游（gateway、MQTT、前端、iOS）只认这套事件。它的价值在于「换后端不改下游」，虽然现在只有 pi 一个后端，但这条边界仍然是清晰的。

### 17.1 命令面

从 `client.rs` 看，daemon 向 host 发的命令包括：

| 命令 | 作用 |
|---|---|
| `open_session` | 打开一个已存在会话（resume） |
| `new_session` | 新建会话 |
| `close_session` | 关闭会话（LRU 或显式） |
| `prompt` | 发一轮提示，带 `streamingBehavior` |
| `abort` | 中断指定会话（不发散到其他会话） |
| `set_model` | 会话级模型切换 |
| `get_available_models` | host 级可用模型目录 |
| `get_state` | 读取会话状态 |
| `get_entries since` | 拉取从某 leaf 之后的事件（崩溃回补） |
| `get_commands` | 运行时可用命令列表 |
| `fork_session` | 从某个 leaf id 分叉 |

每条命令带一个 `id` 用来关联 response。Host 模式下每条命令和每条事件都带 `sessionId`；LegacyRpc 模式下不带，需要 daemon 回退到「当前活跃会话」。

### 17.2 事件面

`translate.rs` 把 pi 事件映射为 `AcpEvent`：

| pi 事件 | AcpEvent | 下游表现 |
|---|---|---|
| `message_update` / `text_delta` | Output | 流式文本 |
| `message_update` / `thinking_delta` | Thinking | 思考块（当前 UI 未渲染，代码路径保留） |
| `tool_execution_start` | ToolUse | 工具调用卡片 |
| `tool_execution_end` | ToolResult（isError 映射） | 工具结果行 |
| `agent_end` | StatusChange | 回合完成 |
| `extension_ui_request`（confirm） | AcpPermissionRequest | 权限卡片 |
| `extension_ui_request`（带标记的 select） | `question_asked` | 提问卡片 |
| `extension_error` | AcpError | 错误 |
| `replay_entries` | 去重重放 | 崩溃回补 |

**为什么要有 translate 这一层？** 因为 pi 的事件形状是 pi 的，而 TeamClu 需要一套稳定的语义。如果没有这一层，前端就变成了「直接解析 pi 事件」，pi 一升级前端就要改。译层的存在让「pi 变了」变成「改一个文件 + 一组契约测试」。

---

## 18. 一次 prompt 的完整生命周期

把发一条消息到收到回复的完整链路展开：

1. **前端发送。** `use-chat-send.ts` 把消息写入本地（outbox / 云端），然后发 daemon 的 prompt 请求，带 `sessionId`、`streamingBehavior`、模型选择。
2. **daemon 解析会话。** 看 `runtimes.toml` 有没有这个会话的绑定；没有就走「ensure runtime」流程（起进程、open/new session）。
3. **进程池取得 host。** 按 (isolation domain, env revision, worktree) 找进程；没有就物化 host.mjs + extension，注入 env，起进程；有就直接用。
4. **并发守卫。** 如果该会话已经有一个在跑的 turn，行为取决于模式：Host 模式下每个会话独立，可以并发；LegacyRpc 模式下有 mid-turn 守卫，第二个会话会被拒绝重试。
5. **prompt 进入 host。** host 内对应 `AgentSession` 开始跑，产出 `message_update` / `tool_execution_*` 事件。
6. **权限拦阻。** 工具执行前 extension 判断：放行还是询问。询问就走 `confirm` → daemon → 前端；gateway 会话自动批准。
7. **事件翻译。** `events.rs` 逐行解析 stdout → `translate.rs` 翻译 → `amux.AcpEvent`。
8. **双路分发。** 一路进 `session/live` MQTT（给所有订阅者），一路直接回给发起请求的客户端（HTTP/长连接）。
9. **回合结束。** `agent_end` 触发聚合，`turn_aggregator` 把流式内容整理成最终消息。
10. **持久化。** 最终内容由 daemon 写入云端（或走 outbox），同时进 `message.parts[]`。前端的流式 store 与最终内容由唯一的 reconcile 点对齐。

这条链路上有三个「必须做对」的点：

- **并发**：多个会话共享一个 host，事件必须按 `sessionId` 路由，不能串；
- **权限归属**：UI 请求必须回到正确的会话（host 模式下 uiContext 按会话闭包，请求天然归属正确会话）；
- **完成**：回合完成事件只有一次，聚合不能重复。

---

## 19. 多会话并发与隔离

Host 模式的核心卖点是多会话并发。它的实现要点：

**进程内共享。** extension、MCP 桥、model registry 都在 host 进程内共享一份。所以开 10 个会话不会装 10 份 MCP client——这是把 host 写成多会话而不是「一会话一进程」的主要原因。

**会话级闭包。** 权限的 uiContext 按会话闭包，所以「哪个会话触发的权限请求」不需要额外字段来判断。这是一个很干净的设计：用闭包代替显式的 session id 传递。

**per-session abort。** `abort {sessionId}` 只中断该会话，不影响其他会话。这在 LegacyRpc 下是做不到的（单活动会话），也是 Host 成为默认模式的原因之一。

**会话上限 8 与 LRU。** 每个 host 软上限 8 个常开会话，超出按 LRU `close_session`。route 保留，所以下次 prompt 会重开——对用户表现为「冷启动一下」，而不是「会话丢了」。

**隔离域。** 进程池键的第一个维度。不同 isolation domain 不共享进程，这是安全与环境的边界。

一个容易问的问题：**为什么不是一会话一进程？** 因为 MCP 冷启动和基础内存很贵。一个 npx 起的 MCP server 可能要几秒才能 `tools/list`，每会话一份会让「发第一条消息」慢到不可接受。共享进程是唯一能同时满足「快」和「隔离」的折中。

---

## 20. 团队 Skills 的 daemon 侧对账

共享 agent 也需要 skills，而 skills 来自团队注册表。daemon 侧的 `runtime/team_skills.rs` 与成员侧共用 `crates/teamclu-skillpack` 的清单 / 判脏 / 换文件 / frontmatter 回写。

两种主体的对账方式不同：

- **成员侧**跑在桌面端的 `TeamSkillAutoFollow.tsx`，10 分钟后台对账；
- **共享 agent 侧**跑在 daemon，随 agent 的生命周期。

为什么要分开？因为成员侧的对账发生在「用户的机器上」，而共享 agent 可能跑在一个没有用户登录的 daemon 上（服务器场景）。两者共用同一套 skillpack 逻辑，但触发时机不同。

这块的详细设计在第 6 篇。

---

## 21. 故障模式与诊断

agent 这块的故障有一张清单，每一项都对应一个可见的 UI 状态：

| 故障 | 表现 | 对应机制 |
|---|---|---|
| Node 缺失 / 过旧 | 引导安装 | doctor 不满足 |
| pi 包缺失 | 引导安装 | `pi_install` |
| SDK 缺失 | MCP 工具不可用，其余正常 | extension 动态 import |
| agent 离线 | 横幅 | `EngagedAgentOfflineBanner` |
| runtime 冷启动 | 继续横幅 | `SessionContinueBanner` |
| 权限等待 | 等待横幅 / 卡片 | `PermissionWaitingBanner` |
| 子进程崩溃 | 回补后继续 | `backfill_and_close` |
| 环境变量变更 | 换进程 | env revision |
| 模型不可用 | 报错 / 切换 | `get_available_models` |
| 网关 token 过期 | 重新登录 | gateway 侧 |

一个总原则：**agent 层不会静默失败。** 用户看到的每一个「卡住了」都应该有一个明确的、可操作的提示。这是为什么仓库里有这么多 banner 和 notice 组件——它们不是过度设计，是每个失败模式补上的一个补丁。

---

## 22. 与其它模块的接口

| 模块 | daemon 侧的接口 |
|---|---|
| 会话 / 消息 | 创建云端会话、写消息、拉历史 |
| MQTT | 订阅 session/live、actor/state、rpc、sync |
| 通道网关 | `channels/core` 的统一入站出站 |
| 团队同步 | `sync/oss`、`sync/watch`、`sync/scheduler` |
| Skills | `runtime/team_skills.rs` 对账 |
| MCP | extension 桥 + `TEAMCLU_MCP_SERVERS` |
| Cron | 执行 cron turn（`server/cron.rs`） |
| Remote tools | `amuxd-remote-tools` MCP |
| 终端 | 不在 daemon，在桌面进程（`apps/desktop/src/terminal/`） |
| introspect | loopback HTTP 给 `teamclu-introspect` sidecar 用 |

---

## 23. 开发与调试

### 23.1 本地跑 daemon

```bash
pnpm daemon:run          # 从 apps/daemon 跑 amuxd
pnpm daemon:test         # daemon 测试
pnpm dev:daemon          # 开发模式
scripts/amuxdctl.sh      # daemon 控制（pnpm daemon:ctl）
```

桌面端开发时，daemon 通常由 supervisor 拉起。如果已经有一个 daemon 在跑，重复调用会连接现有的而不是再起一个——这是 daemon 作为 companion service 的基本行为。

### 23.2 看什么日志

- daemon 的 stdout/stderr（开发时直接看终端）；
- `LiveDebugConsole`（设置页里的实时调试面板）；
- `AcpStreamDebugPanel`（聊天里的 ACP 流调试）；
- `lib/diagnostics/` 的诊断 bundle。

一个有用的习惯：**当 agent 行为莫名时，先看 daemon 收到的 prompt 与它发回的事件**，而不是先怀疑模型。大多数「agent 不听话」实际是「prompt 没送到」或「事件路由到了错误的会话」。

### 23.3 调试 host

`tests/pi_host.rs` 的 stub SDK 是一个很好的起点：它让你不装真 pi 也能跑通协议。要验证一个新的 host 命令，先在 stub 里实现它，再写真 pi 的集成测试。

`AcpStreamDebugPanel` 直接展示 ACP 事件流，是排查「事件串会话」这类问题的最快路径。

---

## 24. 部署与运维

### 24.1 两种形态的差异

| | 随桌面安装 | 独立 CLI |
|---|---|---|
| 启动方 | 桌面 supervisor | systemd / 手工 / 容器 |
| GUI | 有 | 无 |
| cron 调度 | 在桌面进程 | 无（除非有别的调度器） |
| 通道网关 | 有 | 有 |
| 团队同步 | 有 | 有 |
| agent | 有 | 有 |

一个容易被忽略的事实：**cron 的调度器在当前代码里仍然在桌面进程**（`apps/desktop/src/commands/cron/`，一个 workspace 一个 `CronInstance`），daemon 只执行触发的 turn（`apps/daemon/src/daemon/server/cron.rs`）。所以无头 daemon **没有定时能力**。ADR-0010 决定把调度器整体搬到 daemon，但目前代码里桌面端仍有调度器。读这块时以代码为准。

### 24.2 多品牌

daemon 的家目录带 brand 后缀（`~/.amuxd-<brand>`），这是因为同一台机器可以装多个品牌的变体。`docs/architecture/multi-brand-local-daemon.md` 记录了布局。也见 `docs/architecture/amuxd-home-layout-v2.md`。

### 24.3 升级

Node 与 pi 的升级由我们的 lock 决定，不是用户决定。所以「升级 amuxd」可能意味着「换 Node + 换 pi + 换 SDK」三件事一起发生。doctor 是验证点。

OOM 与资源：一个 host 进程跑 N 个会话，内存主要花在 MCP client 与模型上下文。8 个会话的软上限是一个保守值；如果将来有真实的内存数据，可以调。

---

## 25. 为什么这些设计是必要的：一个对比

把「没有 daemon」的世界推演一遍，能更清楚地看到 daemon 的存在价值。

**假如 agent 跑在客户端进程里：**

1. 关窗口 = agent 死。那么「晚上 11 点定时发一份日报」就只能靠「开着电脑别关窗口」。
2. 两个客户端 = 两个 agent 身份。那么「团队里这个 agent」就不再是一个实体。
3. 每个客户端都要实现一遍权限、MCP、模型目录、fork。iOS 用 Swift 重写一遍，Expo 用 TS 重写一遍，扩展再重写一遍。
4. 通道网关没地方放。企微给你发消息时，你的窗口不一定开着。

**假如 daemon 不能托管运行时（依赖用户的 Node）：**

那么「零手动安装」不成立，而实际故障率会高到不可维护——ADR-0015 列的那四个 Node 问题（PATH、nvm、多 Node、npm.cmd）会变成主要支持负担。

**假如 daemon 支持四个 runtime：**

那么每个新功能都要在四个后端上验一遍，而实际上团队只有一个后端用得最多。ADR-0014 砍掉的是边际收益最小、维护成本最高的那部分。

这三个反事实是本文所有决策的共同理由。

---

## 26. 常见问题

**Q：为什么本地 agent 不能选 opencode 了？**
A：ADR-0014 删除了选择机制。`AgentType` 枚举还在，是因为存量数据需要它；但实际执行永远是 pi。

**Q：为什么我装了 Node 但 daemon 还说缺？**
A：daemon 用的是自己托管的 Node，不是你的。这是故意的——不猜用户的 Node。

**Q：权限请求为什么会自动通过？**
A：只有在 gateway 会话（`is_gateway`）里才会。因为那是无人值守的，等审批就等于不跑。

**Q：agent 上下文丢了怎么办？**
A：从 opencode 迁移过来的会话会有这个问题（ADR-0014 记录的代价）。聊天记录在云端不丢，丢的是 agent 的上下文记忆。

**Q：能同时跑多个 agent 吗？**
A：能。一个 host 进程内可以并发多个会话；不同 worktree / isolation domain / env revision 会进不同进程。

**Q：为什么 MCP server 改了不用重启？**
A：因为 config 文件有 watcher，且 bridge 注册表挂在 `globalThis` 按签名复用。

**Q：怎么知道某个模型能不能用？**
A：`get_available_models`（host 级）。团队可以有自己的 AI 网关和模型分级，见 `services/ai-gateway/` 与 `docs/specs/2026-08-28-team-ai-gateway-design.md`。

---

## 27. 术语补充

| 词 | 在本文里的含义 |
|---|---|
| host | 多会话 pi 进程（`host.mjs`） |
| LegacyRpc | 单会话回退模式 |
| isolation domain | 进程隔离域 |
| env revision | 进程环境版本，变了就换进程 |
| canonical worktree | 规范化工作区路径 |
| route | TeamClu session ↔ pi session 的绑定记录 |
| leaf id | pi 会话内的条目 id，fork 与回补的锚 |
| gateway session | 由外部通道创建的会话，权限自动批准 |
| doctor | 安装与健康的真相源 |

---

## 28. 与 Cloud API 的边界

daemon 在架构上是「客户端」，不是「服务端」——它调 Cloud API，不提供 Cloud API。这个定位很重要，因为它意味着：

1. daemon 不直连 Supabase。它和桌面端、iOS 一样，只能走 `/v1`。
2. daemon 持有一个**服务身份的 token**（它代表本机的 agent actor），而不是用户的登录 token。一个 daemon 可能服务多个会话，但只有一个 actor 身份。
3. agent 写消息时，写入的是自己 actor 的消息，而不是「代表某个用户」。会话参与者里人和 agent 是并列的 actor。

一个容易混淆的点：**daemon 会从 Cloud API 拉团队配置**（比如团队 AI 网关、团队 MCP、团队环境变量），但这些都不改变「daemon 是客户端」这个定位。它只是消费了更多配置。

关于 agent actor 的身份模型，两条相关 ADR：

- **ADR-0001**：actor 类型简化为 member / agent 两种；
- **ADR-0002**：一个 actor 只运行一种 agent 类型。

第二条是「一个 daemon = 一个 agent 身份」的上游约束。它也解释了为什么「一个 actor 既是 op错了又让 pi 跑」是不允许的——actor 的类型是身份的一部分，不是运行时参数。

---

## 29. 一个真实的坑：env 串味

进程池键从「只按 worktree」改成「(domain, env revision, worktree)」之前，存在一个真实 bug：env 池是全局 first-wins，所以 workspace A 先起进程、注入了 A 的环境变量，workspace B 再请求时会复用 A 的进程，拿到 A 的环境变量。

这类 bug 的特点：

- **只在特定顺序下复现。** 先开 A 再开 B 就会中，反过来不会。
- **症状离原因很远。** 用户看到的是「B 里的 agent 用错了 API key」，而真正的原因在 A 的启动。
- **不会报错。** 进程起来了，请求成功了，只是用错了配置。

修法（把 env revision 加进键）背后的原则是：**任何「进程级共享状态」都要有一个维度来表达它什么时候变。** 共享进程是为了省资源，但省的前提是「共享的东西对两个请求确实一样」。env 不一样就不能共享，这个判断必须由键来做，不能靠调用方记得检查。

这条经验与知识库同步里的「`known` 表与 `files` 表分离」是同一个思路：**不要把「两种语义不同的东西」放在同一个容器里，然后用标志位区分，因为总有人忘了检查标志。**

---

## 30. 阅读代码的建议顺序

想真正接手这块，建议按这个顺序读：

1. `apps/daemon/src/runtime/backend.rs` —— 先看 trait。整个 daemon 对 agent 的所有需求都在这里。
2. `apps/daemon/src/runtime/manager.rs` —— 看 `RuntimeManager` 如何用 backend。
3. `apps/daemon/src/runtime/pi_rpc/mod.rs` —— 看 `PiRpcBackend` 与 `pi_server_spec`。
4. `apps/daemon/src/runtime/pi_rpc/process.rs` —— 看进程池键。这是整个模块最难的部分。
5. `apps/daemon/src/runtime/pi_rpc/translate.rs` —— 看事件映射。这对测试友好。
6. `apps/daemon/src/daemon/runtime_resolution.rs` —— 看唯一的 agent_type 归一化点。很短，但很重要。
7. `docs/architecture/pi-agent-backend.md` 全文 —— 最好在设计上下文中看前面几步。

不建议先读 `events.rs`：它是路由逻辑，涉及并发、归属、回补，在没有前面五步的上下文时读会以为它一团乱。也不建议先读 `host.mjs`：它是对 pi SDK 的封装，不知道 ACP 的约束就不知道它为什么这么写。

---

## 31. 维护约定与变更记录

维护本文时要同步更新：

- **pi 不再是唯一 runtime**（推翻 ADR-0014），第 3 节要重写；
- **Node/pi 不再托管**（推翻 ADR-0015），第 4 节要重写；
- **cron 调度器搬到 daemon**（ADR-0010 真正完成），第 24.1 节的「以代码为准」段落要改；
- **进程池键变了**，第 5.3 节要改；
- **权限模型变了**（不再用 extension），第 7 节要改；
- **MCP 改为 pi 原生支持**（上游变了），第 8 节要精简。

一条写作约定：本文只陈述「现在是什么」。当一节写的是 ADR 的意图而代码还没跟上的（比如 cron），必须同时写清「ADR 说的是什么、代码现在是什么」。这两者混在一起会让后来者信错文档。

---

## 32. 附录：agent 与 MQTT 主题

daemon 是 MQTT 上的主要订阅者与发布者。与 agent 直接相关的主体：

| 主题 | 方向 | 用途 |
|---|---|---|
| `amux/<team>/session/<sid>/live` | 订 / 发 | 会话内 actor 通信 |
| `amux/<team>/<actor>/state` | 发 | 在线状态 |
| `amux/<team>/<actor>/notify` | 订 | 通知 |
| `amux/<team>/<actor>/rpc/req` | 订 | remote-tools 请求 |
| `amux/<team>/<actor>/rpc/res` | 发 | remote-tools 响应 |
| `amux/<team>/<actor>/runtime/<rid>/commands` | 订 | runtime 命令 |
| `amux/<team>/<actor>/runtime/<rid>/state` | 发 | runtime 状态 |
| `amux/<team>/sync/<resource>` | 订 | 同步 hint |

主题字面量的权威定义在 `crates/teamclu-types/src/mqtt.rs`，FC 与 iOS 各有一份镜像。**三处必须一致**，且都有断言主题字面量的测试。一个具体的教训：`MQTT_FALLBACK_TEAM_ID` 在品牌改名（teamclaw → teamclu）时故意没改——因为它是 rendezvous point，两端独立升级，没有迁移手段，改名会让所有混合版本的无团队设备对之间静默失联。

---

## 33. 附录：agent 的生命周期状态

一个 agent 从「刚被创建」到「可以对话」的状态：

```
创建 actor
  → 绑定设备（daemon）
    → 设备注册 runtime
      → runtime 就绪（host 进程起来，模型可用）
        → 会话绑定（route: teamclu session ↔ pi session）
          → 可对话
```

前端看到的是 `useActorPresenceStore` / `agent-presence-store` 与 runtimeStates。每个状态在手势上都有对应 UI：没绑设备时不能发起会话；设备离线时显示离线横幅；runtime 未就绪时显示继续横幅。

关键的实现文件：

- `lib/agent/`：身份、模型、可达性、状态；
- `lib/daemon/`：发现、RPC、工作区、admin；
- `lib/teamclu/`：ACP 命令与权限；
- `stores/actor-presence-store.ts`、`stores/actor-directory-store.ts`。

---

## 34. 附录：常见配置项

daemon 的配置在 `daemon.toml`，但大部分用户不会直接编辑它：

| 配置 | 作用 | 谁会改 |
|---|---|---|
| `[agents.pi] session_host` | `host` / `rpc` 模式 | 一键回退时 |
| `[agents.pi] node` / `package_root` | 显式路径 | 开发者 |
| team 绑定 | 当前团队 | 登录 / 加入时自动 |
| 模型 / provider | `~/.pi/agent/` | 设置页 |

团队级配置在 Cloud API：团队 AI 网关、团队 MCP、团队环境变量。它们在 workspace 组装时合并到 agent 的环境里，优先级是团队 < inherent < 用户（详见 `docs/architecture/team-mcp-and-env-cloud.md`）。

---

## 35. 一个总结：协议、进程、托管

把整篇压缩成三件事：

**协议。** ACP 是 daemon 与 pi 之间的语义层。它的价值不在「现在有几个后端」（现在只有一个），而在「换后端不改下游」。translate 层与它的契约测试是这条边界的守卫。

**进程。** 进程池键是 `(isolation domain, env revision, canonical worktree)`，会话上限 8 与 LRU，宿主重用与 per-session 闭包。这三件事决定了一个 daemon 能不能同时服务多个会话而不串味、不爆内存、不丢会话。

**托管。** Node 与 pi 由 amuxd 自己装，不从用户机器上找。这条决定了「零手动安装」能不能成立，也决定了升级时「Node + pi + SDK」三个东西一起换。

三件事背后的同一个判断是：**daemon 是 agent 的家，客户端只是它的窗口。** 一旦接受这一点，「为什么 iOS 没有 agent」「为什么关掉 app agent 还在」「为什么权限由 daemon 管」都会变得自然。

两个需要诚实记录的事实：**cron 调度现在仍在桌面**（第 8 篇），以及 **`AgentType` 枚举还在但非 pi 输入会被归一化**。读过本文的人不应该以为「多 runtime」还是支持的。

---

## 36. 附录：为什么这块的设计几乎都在防串味

把 daemon 的设计约束排一排，会发现一个共同主题：**防止属于 A 的东西跑到 B 身上。** 这是一个看起来很平庸的主题，但它是这块一半以上复杂度的来源。

### 36.1 进程池键里的 env revision

如果进程只按 worktree 池化，env 就是全局 first-wins：先为 workspace A 起的进程会被 B 复用，B 拿到 A 的环境变量。后果是「B 里的 agent 用错了 API key」，而原因在 A 的启动。

把 env revision 加进键之后，环境一变就换进程。这条修正的代价是更频繁的进程启动，收益是「共享的进程一定是真的相同」。

### 36.2 事件按 sessionId 路由

Host 模式下多条会话共用一个进程，事件必须严格按 `sessionId` 路由。一条事件如果落到了错误的会话，用户看到的是「别的会话的话出现在我这里」。

Legacy 模式没有这个信息，所以它回退到「当前活跃会话」，也所以它成为回退而不是默认。

### 36.3 UI 请求按会话闭包

权限与 question 的 UI 请求必须回到正确的会话。Host 模式下 uiContext 按会话闭包，所以「哪个会话触发的权限请求」不需要额外字段——这个归属是自然的。

但如果它在归属逻辑里被处理错了（比如把 `auth_*` 事件算到当前活跃会话头上），登录提示就会出现在聊天里。这也是为什么 `auth_*` 必须在 session 归属之前截获。

### 36.4 进程级 MCP 注册表不能被 per-session 刷新

remote-tools MCP 挂在进程级注册表上。如果 `session/resume` 时去刷新它，一个会话的刷新会影响同进程的其它会话。所以 host 启动时就带上 inherent MCP，resume 不动它。

### 36.5 同一主题在其它模块里

这四个不是孤立的设计。同一条主题在本仓库里到处都是：

| 模块 | 串味形态 | 修法 |
|---|---|---|
| daemon | env 跨 workspace | 进程池键加 env revision |
| 渠道 | 多个 bot 同名群 | `bot_id` 进 Conversation 键 |
| 知识库 | 冲突副本被扫描器误判 | 硬排除 `.conflicts/` |
| 会话 | 子 agent 事件归到主会话 | subagent route |
| 远程工具 | agent 向非参与会话发 rpc | fail-closed 校验 |

五条的形态不同，但都是「一个容器的键不够细」。这也是一个可用的检查方法：**当一个系统表现出「偶尔用错东西」时，先看它的容器键是不是缺少一个维度。**

### 36.6 为什么这类 bug 特别难查

因为它们**不报错**。进程起来了，请求成功了，只是配置不对；事件送到了，只是送到了别的会话；消息发出去了，只是发错了人。

一个不报错的 bug 需要靠对比才能发现：对比两个环境下同一个请求的行为、对比两个会话里同一条消息的归属。而这类对比往往需要同时复现两边，成本很高。所以正确的策略是在设计时就补上那个维度，而不是等它出现后用诊断去追。

---

## 37. 附录：agent 的最后一道防线

daemon 里有几层「即使上层错了也不会造成灾难」的保险，它们值得单独列出来，因为它们是这块真正的安全网。

### 37.1 kill_on_drop

进程句柄在 drop 时杀进程。这保证了一个 host 不会在它的所有者（某个请求、某个路由）已经消失后还在跑。没有它，一个崩溃或超时的请求会留下一堆孤儿进程，它们继续吃内存、继续持有会话文件。

### 37.2 软上限 8 与 LRU

一个 host 最多常开 8 个会话，超出按 LRU 关闭。这本身是内存优化，但它同时是一道保险：一个异常客户端不能通过开一千个会话把 host 拖死。

「软上限」的意思是它不是硬拒绝：route 保留，下次 prompt 重开。所以用户看到的是「冷启动一下」，而不是「会话丢了」。这是一个很好的降级设计：**限制资源但不丢语义。**

### 37.3 未知 sessionId 丢弃

`events.rs` 对未知 `sessionId` 的事件选择丢弃而不是报错。理由是「不影响他会话」。如果改成报错，一个后台残留会话的事件就能把当前会话的流打断。

### 37.4 EOF 结算

子进程崩溃时，EOF 触发「结算该进程全部在跑 turn」并尝试 `get_entries since` 回补。这保证了一个崩溃不会让一个 turn 永远停在「进行中」。

这与 cron 的 heartbeat/stale 是同一个思路（第 8 篇）：**一个已经不存在的东西不能看起来还在跑。** 区别只是 cron 靠时间判断，daemon 靠 EOF 判断。

### 37.5 doctor 是唯一真相

没有 `setup-ok` 缓存，每次 refresh 都问 doctor。这是一个看起来「浪费」的选择，但它防的是「机器的状态变了而系统还以为是好的」——卸载了 Node、公司 IT 推了新 PATH、装了两个版本。

### 37.6 这些保险的共同点

六条保险里有五条在防同一件事：**一个已经过时/消失的状态继续被当作有效。** 孤儿进程、超限会话、未知会话的事件、崩溃的 turn、过时的安装状态——它们都会造成「看起来在工作但实际不对」。

这与前面「防串味」是同一枚硬币的两面：串味是「错的东西被当成对的」，过时是「旧的东西被当成新的」。两者都不报错，所以都需要在设计时就补上那道检查。

---

## 38. 附录：这块的运维视角

从运维的角度看 daemon，需要知道四件事：

**一、它在哪。** 随桌面安装时是 companion service；服务器场景是独立 CLI。两种形态共享同一套命令与配置，区别在处理与启动方式。

**二、它占什么。** 托管的 Node + pi + SDK 在 cache 目录（约 100MB）；每个团队一份内容根；每个 host 进程有会话上限 8。磁盘与内存的大头是 MCP 进程与会话上下文。

**三、它什么时候会重。** 环境变量变了（env revision）会换进程；团队切换会解析新内容根；配置改了（MCP 表）不必重启（有 watcher）。

**四、怎么知道它好着。** doctor 是唯一真相，包含 Node/pi/SDK 三件事。设置页的 daemon 三个 section（general/workspaces/runtimes）是它的 UI。

一个运维上的建议：排障时先看 Node 与 pi 的版本，因为「agent 起不来」的大部分原因是这两个不对。这与 ADR-0015 的结论一致：托管正是为了消除这一类问题，但如果托管本身没有装好，症状会与「用户环境不对」一样。

---

## 39. 附录：一个可以复用的判断

这篇的核心判断可以压缩成一句：**「这个东西是共享的还是独有的？」**

- 进程是按 (domain, env, worktree) 共享的，所以键里必须包含所有影响「相同性」的维度；
- 事件是独有的（属于某一个会话），所以必须按 sessionId 路由；
- MCP 注册表是共享的，所以不能被 per-session 刷新；
- 会话文件是按 worktree 独有的，所以 resume 不受 env 变更影响；
- 安装状态是托管独有的，所以不从用户环境里找。

一个实用的方法：引入一个共享容器（进程、缓存、注册表、连接）时，先列出「哪些东西必须是共享的，哪些其实是独有的」。然后确保独有的那些有一个键可以区分。绝大多数串味 bug 都是把一个独有的东西放进了共享容器而没有加键。

---

## 40. 附录：两句话记住这块

**第一句：daemon 是 agent 的家，客户端只是它的窗口。** 所有「为什么 iOS 没有 agent」「为什么关 app 还在跑」「为什么权限由 daemon 管」都是这一句的推论。

**第二句：共享的进程需要完整的键，独有的状态不能被共享刷新。** 进程池键、事件路由、MCP 注册表、可选项订阅——它们都在守同一件事。

读完这两句应该能回答一个常见问题：为什么不能把 agent 做进客户端？因为客户端会关，而 agent 不该因为窗口关了而消失。

---

## 41. 附录：三句话的速记

1. daemon 是 agent 的家，客户端只是窗口。
2. 共享的容器需要完整的键。
3. 托管运行时，不猜用户的环境。

记住这三句，就能在大多数设计问题上给出与现有代码一致的选择。

---

## 42. 附录：读完这篇应该能回答的问题

- 为什么本地 agent 只由 daemon 驱动？因为客户端会关，而 agent 不该因为窗口关闭而消失。
- 为什么不探测用户机器上的 Node？因为「哪个 Node」是历史上大部分「装了但起不来」的根因。
- 为什么一个 actor 只能有一种 agent 类型？因为类型是身份，不是运行时参数。
- 为什么权限由 extension 管？因为 pi 没有内建权限。
- 为什么 MCP 由 extension 桥接？因为 pi 官方不做 MCP。

五个问题都指向同一个前提：**daemon 是 agent 的家。**

---

## 43. 结语

这块的本质是：**TeamClu 把 pi 产品化了。** pi 是一个强大但原始的 agent 内核——没有权限、没有 MCP、没有多会话、没有安装管理。amuxd 补的正是这四件事，外加团队同步和通道网关。理解了「daemon 是 agent 的家，客户端只是它的窗口」，后面所有设计（为什么 iOS 没有 agent、为什么关掉 app agent 还在、为什么权限由 extension 管）都会变得自然。
