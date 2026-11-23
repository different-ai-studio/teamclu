# 接入一个新 Agent Type：适配文档与要点

> **已废弃（ADR-0014，2026-09）.** 本地 runtime 已迁移至 pi-only；opencode / cursor / claude 后端已删除。本文保留作历史参考，现行架构见 `docs/architecture/pi-agent-backend.md`。

> 面向的问题：TeamClu 现在有 opencode / pi / cursor / claude 四个 local agent
> backend。本文记录**再接一个需要改什么、哪些坑是共性的**，以及四个已有实现
> 在每个适配点上的真实做法对比。
>
> 前置阅读：[`apps/daemon/src/runtime/backend.rs`](../../apps/daemon/src/runtime/backend.rs)
> 是唯一的抽象边界，看懂它就看懂了一半。

## 0. 一句话架构

```
客户端（Tauri / iOS / gateway）
        │  只认 amux.proto，不知道有几种 backend
        ↓
   RuntimeManager
        │  AcpCommand ↓ / AcpEvent ↑     ← 这条边界不能因为新 backend 而变
        ↓
   dyn AgentBackend
        ├── opencode_http/   全局单进程 `opencode serve`，HTTP + SSE
        ├── pi_rpc/          每 worktree 一个 `pi --mode rpc`，JSONL
        ├── cursor_sdk/      每 worktree 一个 Node sidecar，JSONL
        └── claude_agent/    每 worktree 一个 Node sidecar，JSONL
```

**核心约束：协议零改动。** 新 backend 的全部工作是把它自己的世界翻译成
`AcpCommand` / `amux::AcpEvent` 这套既有词汇。任何"为了新 backend 改 proto /
改前端"的冲动，都应该先怀疑是翻译层没做够。唯一的例外见 §3.7（agent_type 枚举）。

## 1. 必须落地的清单

按依赖顺序，缺一项就是半成品。带 ⚠️ 的是**已经踩过的坑**，在 §3 展开。

| # | 落点 | 文件 | 备注 |
|---|---|---|---|
| 1 | 实现 `AgentBackend` | `runtime/<name>/mod.rs` | 12 个方法，其中 `session_model` 有默认实现 |
| 2 | 工厂注册 | `runtime/backend.rs` `create_backend()` | 一行 match arm |
| 3 | 配置结构体 | `config/daemon_config.rs` | `[agents.<name>]`；同时导出到 `config/mod.rs` |
| 4 | 事件翻译 | `runtime/<name>/translate.rs` | 对齐 `opencode_http/translate.rs` 的词汇表 |
| 5 | 会话 ID 前缀 | `SESSION_ID_PREFIX` | `<name>:<后端自己的 id>`，自包含以便重启后 resume |
| 6 | MCP 透传 ⚠️ | 复用 `runtime/sidecar/mcp.rs` | 见 §3.1 |
| 7 | 权限闭环 ⚠️ | `runtime/<name>/permission.rs` | 见 §3.2，**这是最容易做成空转的一项** |
| 8 | 模型选择与回灌 ⚠️ | `pick_initial_model` + `session_model` | 见 §3.3 / §3.4 |
| 9 | agent_type 枚举 | `proto/amux.proto` + `runtime_resolution.rs` | 见 §3.7 |
| 10 | 分发路径 ⚠️ | doctor + install + 打包 | 见 §3.6，**cursor 至今没做，只能在开发机跑** |
| 11 | 前端设置页 | `LLMSectionRouter.tsx` + `DaemonGeneralSection.tsx` | runtime picker 加一项 + 自己的 LLM 面板 |

## 2. 可以直接复用的东西

`runtime/sidecar/` 是为"Node sidecar + JSONL"这类 backend 抽出来的共享层，
`cursor_sdk` 和 `claude_agent` 都用它：

| 模块 | 内容 | 为什么能共享 |
|---|---|---|
| `sidecar/client.rs` | JSONL 请求/响应客户端（`{id,method,params}` ↔ `{id,result\|error}`，120s 超时，pending 表） | 与具体 SDK 无关，纯传输 |
| `sidecar/mcp.rs` | `opencode.json` 的 `mcp` 表 + remote-tools host config → SDK 的 `mcpServers` record | Cursor SDK 与 Claude Agent SDK 的 MCP 形状**逐字相同**：stdio `{type,command:string,args,env}`、http `{type:"http",url,headers}` |

其它三处虽然长得像但**不要盲抄**：`process.rs`（进程池）、`events.rs`（stdout
路由）、`translate.rs`（事件翻译）。它们的骨架相同、语义不同，见 §3。

另外，非 sidecar 类后端（HTTP、纯二进制 RPC）用不上 `sidecar/`，直接实现
trait 即可 —— opencode 和 pi 就是这样。

## 3. 适配要点（每一条都对应一次真实返工）

### 3.1 MCP 透传：别忘了 `mcp_config_path`

`attach_session` 的 `mcp_config_path` 参数指向 daemon 写的
`remote-tools-host.json`，里面是 `amuxd-remote-tools`（`get_page_dom` /
`show_page_nav_links`）。**除它之外**还要读 worktree 的 `opencode.json` 的 `mcp`
表 —— 那是 MCP 的 SSOT，团队/继承/用户三层配置都合并在里面。

| backend | 做法 |
|---|---|
| opencode | 原生读 `opencode.json`，什么都不用做 |
| pi | 没有原生 MCP，靠 pi extension 代理（`TEAMCLU_MCP_SERVERS` 环境变量） |
| cursor | `sidecar::mcp::assemble()` → `Agent.create({mcpServers})` |
| claude | 同上 → `query({options:{mcpServers}})` |

**坑（cursor 首版踩过）**：SDK 侧 `mcpServers` 是 `Record<string, Config>`
而非数组，且 stdio 的 `command` 是**字符串** + `args` 数组，与 `opencode.json`
的 `command: string[]` 形状不同。传错形状不会报错，只会静默地一个 server 都不加载。

**坑**：inline MCP 通常不被 SDK 持久化，**resume 时必须重传整份清单**。

### 3.2 权限闭环：先搞清楚 SDK 到底有没有带外审批通道

这是最贵的一课。三种可能，先判定属于哪种再动手：

| 机制 | 谁有 | 特征 |
|---|---|---|
| **协议内审批** | opencode (`permission.asked`)、pi（extension dialog）、**Claude Agent SDK**（`canUseTool` 进程内回调） | SDK 主动问、并阻塞等你答。最好做。 |
| **只有 hook** | **Cursor SDK** | 没有任何 respond API，只能靠 `.cursor/hooks.json` 里的 `preToolUse` 命令，SDK spawn 它、读 stdout 的 `{"permission":"allow"\|"deny"}` |
| **完全没有** | —— | 只能静态策略，或者放弃非 full-access 场景 |

判定方法：**读 `.d.ts`，别读文档**。cursor 的 `SDKRequestMessage` 只有一个
`request_id`、没有工具信息也没有 respond 方法，光看名字会以为是审批信号，实际
是 cloud reviewer 的东西、本地 run 根本不触发。首版就是接错了这个信号。

**必答的三个问题：**

1. **full access 会话怎么绕过？** gateway / cron 无人值守，等审批就是挂死。
   claude 用 `permissionMode: 'bypassPermissions'`（SDK 直接不调回调），
   cursor 在 hook 里直接返回 allow。
2. **fail-open 还是 fail-closed？** 取决于**谁在等**：
   - cursor 的 hook 进程是 SDK spawn 的、有超时，路由失败时 **fail-open**——
     一个 fail-closed 的 `preToolUse` 网关会在任何上游抖动时废掉会话里的每一次
     工具调用。
   - claude 的 `canUseTool` 是被阻塞的进程内 promise，路由失败时 **fail-closed**——
     拒绝会让模型收到一条 refusal 继续跑，而放行等于执行了没人批准的工具。

   两者相反，且都是对的。照抄另一个后端的选择会出事。
3. **"始终允许"能不能真的持久化？** 能就带上 SDK 自己的 rule 建议
   （claude 的 `suggestions` → `updatedPermissions`）；不能就**别显示这个按钮**
   （`options_for(can_always)`），否则用户点了以为生效、实际等同一次性放行。

事件载荷别偷懒：`tool_name` / `description` / `params` 要填真值。cursor 首版全
是占位符（`tool_name: "cursor"`、`options: vec![]`），UI 上就是一个不知道在批
什么的框。

### 3.3 初始模型选择：不要 `available.first()`

统一口径（pi 的注释里写了这条经验，claude 照抄）：

```
显式 override → 配置的默认值 → 设备 MRU → 什么都不说（让 SDK 用自己的默认）
```

每一步都要对**实时目录**做可用性校验。两个反面：

- `available.first()`：拿到目录里碰巧排第一的那个，毫无可用性语义。
- 目录为空就返回 None：目录往往需要一个 live session 才拿得到，**首次 attach
  必然是空的**。空 = 未知，不是不可用 —— 此时应该保留用户配置的值。
  `config::first_available` 已经内建了这个语义（`available.is_empty()` 时直接
  返回首个候选），直接用它。

### 3.4 `session_model()`：只能回报后端自己说的值

trait 文档写得很清楚：这个方法用来教设备 MRU 学到它的第一个条目，所以必须返回
**后端报告的**模型，不是我们要求的。

cursor 首版让 bridge 返回自己记的 `entry.model`，等于把我们的猜测回灌进 MRU。
正确来源：

| backend | 权威来源 |
|---|---|
| opencode | `session_model()` 查 HTTP |
| cursor | `agent.model`（SDK 自己的 selection，每次 send 后更新）+ `turn_end` 的 `result.model.id` |
| claude | `system/init` 的 `model` + `result.modelUsage` 的 key |

bridge 侧把"我们要求的"和"SDK 报告的"分成两个字段返回
（`requestedModel` / `sdkModel`），Rust 侧只读后者 —— 这样不会再混淆。

### 3.5 `SetModel`：确认它真的改了模型

cursor 首版的 `set_model` 只改了 bridge 里的一个 map，既不 dispose+recreate
Agent 也不影响正在跑的 run —— UI 上切换成功、实际没变。

先在 `.d.ts` 里找**真正的**切换点：

- Claude Agent SDK：`Query.setModel(model)` 是 control-protocol 调用，真改
  （前提是 streaming input 模式，见 §3.8）。
- Cursor SDK：没有独立 setter，模型在 `agent.send(text, { model })` 里传，
  所以 daemon 的 route 是 source of truth，每次 prompt 都带上。
- opencode：同样是 prompt body 里带（`PromptBody { model, parts }`）。

规律：**如果 SDK 没有独立 setter，就让 daemon 的 route 持有模型、每次 prompt
带过去**，而不是在 sidecar 里存一份状态。

### 3.6 分发：`env!("CARGO_MANIFEST_DIR")` 是个陷阱

Sidecar 脚本路径千万别写成
`env!("CARGO_MANIFEST_DIR")/xxx-bridge/src/main.mjs` —— 打包进 Tauri 的 amuxd
里，这是 CI 构建机的 checkout 路径，用户机上不存在。**cursor 现在就是这样，
所以只有手动 `npm install` 过的开发机能用。**

一个能出开发机的 sidecar backend 需要：

- `<name>_install/` 里有 `run_install()`，不能只有 `doctor()`
  （对照 `opencode_install` / `pi_install`）
- bridge 的 `node_modules` 有人装：它不在 pnpm workspace 里
  （`apps/*` 只匹配一层，`apps/daemon` 也没有 package.json），
  根目录 `pnpm install` 装不到它
- `tauri.conf.json` 的 `resources` / `externalBin` 里有它
- `amuxd doctor` 报告 node、脚本、依赖、凭证四项（这项 cursor 做了）

### 3.7 agent_type 枚举

`proto/amux.proto` 的 `AgentType` 要加一项，否则会话在存储和上报里带的是别的
类型，`evict_agent_types` 也只能一刀切。加完记得补
`daemon/runtime_resolution.rs` 里两个 match（`agent_type_from_name` /
`agent_type_name`）—— 后者是穷尽匹配，不补就编译不过（这是好事）。

claude 复用已有的 `AGENT_TYPE_CLAUDE_CODE = 1`；cursor 这次补上了
`AGENT_TYPE_CURSOR = 5`。

### 3.8 SDK 的"模式"往往决定了你有哪些能力

Claude Agent SDK 的 `interrupt()` / `setModel()` / `setPermissionMode()` 都是
control-protocol 调用，**只在 streaming input 模式下存在**。所以 bridge 必须把
`prompt` 传成一个 async iterable（我们用一个 push 队列）而不是字符串 —— 传字符串
就等于放弃取消和切模型。

同类问题：Cursor SDK 的 `local.cwd` 支持数组，但只有 `cwd[0]` 用于 executor 和
setting sources 解析，其余元素只用于 PR 归因遥测。曾经想靠多根把 hooks.json 放
到仓库外，实测不成立。

**通用做法：动手前先在 `.d.ts` 里确认能力的前置条件，别按文档的乐观描述设计。**

### 3.9 别在 await 上持有 `parking_lot` 锁

`Shared.routes` 用的是 `parking_lot::Mutex`，它的 guard 不是 `Send`。
在 guard 存活期间 `.await` 会得到一句非常绕的
`future cannot be sent between threads safely`。

固定写法：先在锁里 clone 出快照，锁释放后再决策 + await。

```rust
let snapshot = shared.routes.lock().get(session_id).map(|r| (r.event_tx.clone(), ...));
let Some((event_tx, ...)) = snapshot else { ...; return; };
```

### 3.10 turn 生命周期必须自己兜底

`Cancel` 之后不要指望后端一定会补一个 `turn_end`：pi 不可靠，cursor 的
`run.cancel()` 也不保证。统一在 `Cancel` 分支里调一次 `close_turn`
（它 guard 在 `turn_active` 上，是幂等的），否则 UI 永远停在"回复中"。

prompt 提交失败同理：没有 turn 会开始，也就没有 turn 会结束，必须手动
`Active → Idle`。

## 4. 四个后端的适配点对比

| | opencode | pi | cursor | claude |
|---|---|---|---|---|
| 进程模型 | 全局单 `opencode serve` | 每 worktree 一个 | 每 worktree 一个 Node | 每 worktree 一个 Node |
| 传输 | HTTP + SSE | JSONL | JSONL（`sidecar/client.rs`） | JSONL（同左） |
| 会话 ID | opencode session id | `pi:<session 文件路径>` | `cursor:<agentId>` | `claude:<sdk session_id>` |
| MCP | 原生 | extension 桥接 | `sidecar/mcp.rs` | `sidecar/mcp.rs` |
| 权限 | `permission.asked` | extension confirm dialog | `.cursor/hooks.json` 的 `preToolUse` | `canUseTool` 进程内回调 |
| 权限失败方向 | 等待 | 等待 | **fail-open** | **fail-closed** |
| 取消 | `POST abort` | `abort` | `run.cancel()` | `Query.interrupt()` |
| 切模型 | prompt body 带 | `set_model` RPC | send 时带（无 setter） | `Query.setModel()` |
| 模型目录 | `/config/providers` | `get_available_models` | `Cursor.models.list()` | `Query.supportedModels()` |
| 可出开发机 | ✅ | ✅ | ❌（§3.6） | ❌（§3.6） |

## 5. 最小验收清单

一个 backend 可以说"接完了"的判据：

- [ ] 单会话 prompt → 看到流式 Output → 回到 Idle
- [ ] 工具调用产生 ToolUse / ToolResult，`tool_kind` 映射正确
- [ ] 非 full-access 会话弹出审批框，**点拒绝后模型确实收到拒绝**
- [ ] full access 会话（cron / gateway）全程不弹框、不挂起
- [ ] `amuxd-remote-tools` 在该 backend 下可调用
- [ ] 切模型后**下一轮**确实用了新模型（看 `turn_end` 上报的值，不是 UI 状态）
- [ ] daemon 重启后 resume 成功，且 MCP 清单重传
- [ ] 取消一个进行中的 turn，UI 不卡在"回复中"
- [ ] `amuxd doctor` 能诊断缺失的依赖和凭证
- [ ] 在**没有开发环境**的机器上能跑（§3.6）

## 6. 参考实现

- 后端抽象：[`apps/daemon/src/runtime/backend.rs`](../../apps/daemon/src/runtime/backend.rs)
- 共享 sidecar 层：[`apps/daemon/src/runtime/sidecar/`](../../apps/daemon/src/runtime/sidecar/)
- 四个实现：`runtime/opencode_http/`、`runtime/pi_rpc/`、`runtime/cursor_sdk/`、`runtime/claude_agent/`
- 单后端设计稿：[`cursor-sdk-backend.md`](./cursor-sdk-backend.md)、[`pi-agent-backend.md`](./pi-agent-backend.md)
