# Cursor SDK 后端：Composer 模型接入设计

> 状态：设计稿（2026-07-28）。目标：在 `agents.local_agent` 新增 `"cursor"`
> 选项，amuxd 通过 **Cursor SDK**（`@cursor/sdk`）驱动 Composer 2.5 等
> Cursor 自有模型，事件出口仍走 `amux::AcpEvent`，gateway / MQTT / 前端 /
> iOS **零协议改动**。

## 1. 决策与边界

| 决策 | 理由 |
|---|---|
| 走 Cursor SDK，不走 LiteLLM / opencode provider | Composer 不是 OpenAI-compatible raw model API；LiteLLM 无法代理 |
| Rust daemon + Node sidecar 桥接 | `@cursor/sdk` 是 TypeScript；daemon 是 Rust，与 pi 的「子进程 + JSONL」模式一致 |
| 第一版只做 **local runtime** | TeamClu 会话绑定 worktree cwd；cloud VM 需额外 repo 克隆与 PR 流程，延后 |
| 与 opencode **并存**，不替换 | 用户可在设置里切换 `agents.local_agent`；团队 LiteLLM 仍服务 opencode/pi |
| 商业 embedding 需单独授权 | Cursor 官方：SDK 是跑 Agent 的接口，不是可嵌入第三方 SaaS 的 model endpoint；对外售卖前联系 hi@cursor.com |

## 2. 三种运行时对比

| | opencode（现状） | pi（已有） | cursor（本方案） |
|---|---|---|---|
| 进程模型 | 全局单 `opencode serve`（HTTP + SSE） | 每 worktree 一个 `pi --mode rpc` | 每 worktree 一个 Node sidecar（JSONL RPC） |
| SDK / 二进制 | 官方 opencode 二进制 | pi npm / 单文件二进制 | `@cursor/sdk` + `node cursor-bridge.mjs` |
| 会话 ID | opencode session id | `pi:<session-file-path>` | `cursor:<agentId>`（local）或 `cursor:bc-<id>`（cloud，后续） |
| 恢复 | `GET /session/{id}` + directory | `switch_session` + session dir | `Agent.resume(agentId)` + 重传 inline MCP |
| 流式事件 | SSE `message.part.delta` | stdout `message_update` | SDK `run.stream()` → assistant/tool 块 |
| 模型目录 | `/config/providers` | `get_available_models` | `Cursor.models.list()` |
| 鉴权 | opencode provider key / LiteLLM | LiteLLM via pi provider | `CURSOR_API_KEY`（用户或 team service account） |
| MCP | `opencode.json` mcp 表 | pi extension 桥接 | SDK inline MCP on `Agent.create` / `send` |
| 权限审批 | opencode `permission.asked` | pi extension `confirm` dialog | worktree `.cursor/hooks.json` 的 `preToolUse` hook（见 §5）|
| 取消 | `POST abort` | `abort` | `run.cancel()`（需 `run.supports("cancel")`） |

## 3. 目标架构

```
 Tauri / iOS ── MQTT / 本地 HTTP ──┐
 企业微信 gateway ────────────────┤
                                   ↓
                            amuxd RuntimeManager
                                   ↓ AcpCommand / AcpEvent（不变）
                         runtime/cursor_sdk/（Rust）
                                   ↓ JSONL stdin/stdout
                    cursor-bridge（Node，@cursor/sdk）
                                   ↓ local: { cwd: worktree }
                         Cursor Agent（Composer 2.5）
```

**上行**：`Prompt` → sidecar `send` → `agent.send(text)` → 新 run。

**下行**：sidecar 把 `run.stream()` 事件逐条写 stdout → Rust `translate.rs`
→ `AcpEventFrame` → 既有 `turn_aggregator` / MQTT / SSE。

**权限**：SDK 执行 worktree `.cursor/hooks.json` 的 `preToolUse` hook →
`amuxd cursor-permission-hook` 走 `amuxd.sock` 问 daemon → daemon 发
`AcpPermissionRequest` → 客户端审批 → `ResolvePermission` → hook 进程打印
`{"permission":"allow"|"deny"}` 给 SDK。见 §6.5。

协议边界不变：客户端只认 `amux.proto`；`acp_session_id` 前缀 `cursor:`
区分后端，resume 时剥前缀调 `Agent.resume`。

## 4. 新模块：`runtime/cursor_sdk/`（Rust）

对等 `runtime/pi_rpc/`，实现已有 [`AgentBackend`](../../apps/daemon/src/runtime/backend.rs) trait。

| 组件 | 职责 |
|---|---|
| `process.rs` | 每 canonical worktree 拉起 Node sidecar；env 注入 `CURSOR_API_KEY`、MCP JSON；kill_on_drop；指纹变更时 respawn |
| `client.rs` | JSONL 命令写 stdin（带 `id` 关联 response）：`create_agent`、`resume_agent`、`send`、`cancel`、`set_model`、`list_models`、`dispose` |
| `mcp.rs` | `opencode.json` `mcp` + remote-tools host config → SDK `mcpServers` record |
| `hooks.rs` | 在 worktree 写/合并 `.cursor/hooks.json` 的 `preToolUse` 网关 |
| `permission.rs` | hook 请求 → `AcpPermissionRequest` → 等人 → allow/deny |
| `events.rs` | stdout 逐行解析（`\n` 切分），按 `cursor:<agentId>` 路由 `AcpEventFrame` |
| `translate.rs` | SDK 事件 → `amux::AcpEvent`（对齐 `opencode_http/translate.rs` 词汇表） |
| `mod.rs` | `CursorSdkBackend` + route 表 + pending permission 表 |

### 4.1 Sidecar：`apps/daemon/cursor-bridge/`

独立 npm 包（或 daemon 子目录），随 amuxd 分发：

```
apps/daemon/cursor-bridge/
  package.json          # @cursor/sdk 依赖 + lock
  src/main.mjs          # JSONL RPC loop
  src/agent-pool.mjs    # worktree → Agent 实例（await using 生命周期）
  src/mcp-mapper.mjs    # TeamClu MCP 清单 → SDK inline servers
  src/stream-translate.mjs  # run.stream() → bridge 事件行
```

**启动命令**（由 `process.rs` spawn）：

```bash
node /path/to/cursor-bridge/main.mjs --mode rpc
```

**JSONL 请求/响应**（与 pi_rpc 风格一致，便于 Rust client 复用模式）：

```json
{"id":"1","method":"create_agent","params":{"cwd":"/ws","model":"composer-2.5","mcpServers":[...]}}
{"id":"1","result":{"agentId":"abc123","availableModels":[{"id":"cursor/composer-2.5","displayName":"Composer 2.5"}]}}
```

```json
{"id":"2","method":"send","params":{"agentId":"abc123","text":"fix the bug","replyToMessageId":"msg-1"}}
{"event":"assistant_delta","agentId":"abc123","runId":"run-9","text":"Looking at"}
{"event":"tool_start","agentId":"abc123","runId":"run-9","toolCallId":"t1","toolName":"read","args":{...}}
{"event":"turn_end","agentId":"abc123","runId":"run-9","status":"finished","model":"cursor/composer-2.5"}
{"id":"2","result":{"runId":"run-9","status":"finished"}}
```

Sidecar 职责：

- 持有 `Agent` 实例；进程退出时 `Symbol.asyncDispose`
- `create_agent` / `resume_agent` 时**显式**传 `local: { cwd, settingSources: ["project"] }`
  （`[]` 会把 hooks 一起关掉，权限网关就失效了）
- 每次 `send` 后 `await run.wait()`，区分 `CursorAgentError`（startup）与
  `result.status === "error"`（run failed）
- 日志 `agentId` + `runId` 到 stderr（Rust 可采集）

### 4.2 会话 ID 与 resume

```rust
const SESSION_ID_PREFIX: &str = "cursor:";
// acp_session_id = "cursor:abc123"  →  Agent.resume("abc123")
// cloud 后续: "cursor:bc-..."       →  Agent.resume("bc-...")
```

持久化：`SessionStore` 已有 `acp_session_id` 列，无需 schema 变更。daemon
重启后 `AttachSession { resume_acp_session_id: Some("cursor:abc") }` → sidecar
`resume_agent` + **重传 MCP**（SDK 不持久化 inline MCP）。

### 4.3 模型 ID 形状

与现有客户端一致：`provider/model`。

| SDK model id | TeamClu flat id | 说明 |
|---|---|---|
| `composer-2.5` | `cursor/composer-2.5` | 默认 |
| `auto` | `cursor/auto` | 服务端选择 |
| 带 params 变体 | `cursor/composer-2.5` + MRU 元数据 | params 存 daemon 侧，send 时展开 |

`model_catalog()`：`Cursor.models.list()` 缓存 60s（对齐 `ManagedLlmResolver` TTL
思路），写入 [`DeviceModelCatalog`](../../apps/daemon/src/config/model_catalog.rs)。

`SetModel`：不销毁 Agent；更新 sidecar 内 model 选择，**下一 turn** 生效
（与 opencode 行为一致）。若 SDK 要求重建 Agent，sidecar 内部 `dispose` +
`create` 并对客户端透明。

## 5. 事件翻译（SDK → AcpEvent）

参考 [`pi_rpc/translate.rs`](../../apps/daemon/src/runtime/pi_rpc/translate.rs) 与
[`opencode_http/translate.rs`](../../apps/daemon/src/runtime/opencode_http/translate.rs)。

| SDK stream 事件 | AcpEvent |
|---|---|
| `assistant` + `text` block delta | `Output { text, is_complete: false }` |
| `assistant` + thinking/reasoning block | `Thinking { text }`（若 SDK 暴露；否则忽略） |
| tool call start | `ToolUse { tool_call_id, tool_name, params, tool_kind }` |
| tool result | `ToolResult { tool_call_id, summary, is_error }` |
| run finished | `StatusChange { status: Idle }` + 可选 `AgentReply` meta |
| run error | `AcpError` + `StatusChange { status: Error }` |
| `preToolUse` hook 调用（不是 stream 事件） | `PermissionRequest` |

`tool_kind` 映射（与 pi/opencode 对齐）：`read`→read, `edit`/`write`→edit,
`bash`/`terminal`→execute, 其余→other。

## 6. MCP / remote-tools / skills

TeamClu 已在 worktree 物化 MCP 配置（`opencode.json` / daemon workspace API）。
Cursor 后端**不读 opencode.json 的 provider 段**，只复用 MCP 清单：

1. attach 时 daemon 把 workspace 已启用 MCP 转为 SDK `mcpServers` **record**
   （stdio: `{type,command:string,args,env}`；HTTP: `{type:"http",url,headers}`）
2. `amuxd-remote-tools` 保留为 stdio server（与 pi extension 桥同等优先级）
3. **inline MCP 在每次 `resume_agent` / `send` 时重传**（SDK 限制）
4. `.cursor/skills` / TeamClu skills：第一版不自动映射；后续评估 SDK
   `settingSources` 或 system prompt 注入

`is_gateway` 会话：daemon 在 hook 回调里直接 allow（对齐 opencode gateway
行为），不弹审批。

## 6.5 实测修正（对 `@cursor/sdk@1.0.24` 的核对）

设计稿写作时的三处假设与 SDK 实际行为不符，实现按后者：

1. **SDK 没有带外审批 API。** `SDKRequestMessage`（`messages.d.ts:70`）只带一个
   `request_id`，没有工具信息也没有 respond 方法，且是 cloud reviewer 信号，
   本地 run 不触发。本地唯一的审批机制是 Cursor hooks：SDK spawn hook 命令、
   喂 stdin、读 stdout 的 `{"permission":"allow"|"deny"}`，`deny` 会把该调用变成
   `permission_denied` 拒绝。用 `preToolUse` 这一个通用步骤覆盖所有工具
   （payload 带 `tool_name` / `tool_input` / `cwd`），每条 hook 的 `timeout`
   （秒）可配，所以 hook 进程可以阻塞着等人。
2. **`settingSources: []` 会连 hooks 一起关掉**，因此改为 `["project"]`；
   顺带 worktree 自己的 rules / AGENTS.md 也开始生效（与 opencode/pi 一致）。
3. **`mcpServers` 是 `Record<string, McpServerConfig>` 而非数组**
   （`options.d.ts:235`）；stdio 项的 `command` 是**字符串**+`args` 数组，
   与 `opencode.json` 的 `command: string[]` 形状不同，需转换。

hooks 文件只能放在 worktree 内：`local.cwd` 传数组时 SDK 只取第一个根
（`Array.isArray(cwd) ? cwd[0] : cwd`）来解析 setting sources，旁路目录不会被扫描。
写入时与用户已有 `.cursor/hooks.json` 合并（只替换带 `cursor-permission-hook`
标记的条目），并登记进 `.git/info/exclude`。

审批链路 fail-open：路由不到会话、事件通道关闭、超时都返回 allow —— 一个
fail-closed 的 `preToolUse` 网关会在任何上游抖动时废掉会话里的每一次工具调用。

## 7. 配置落点

### 7.1 Daemon（`~/.amuxd/daemon.toml`）

```toml
[agents]
local_agent = "cursor"   # "opencode" | "pi" | "cursor"

[agents.cursor]
# API key：优先此处，其次环境变量 CURSOR_API_KEY
api_key = "cursor_..."
# sidecar 入口；缺省用 bundled cursor-bridge/main.mjs
bridge_command = ["node", "/path/to/cursor-bridge/main.mjs", "--mode", "rpc"]
# 第一版固定 local；后续 "cloud"
runtime = "local"
# 默认模型（SDK id，非 flat id）
default_model = "composer-2.5"
```

密钥存储：走现有 daemon secret 模式（600 权限文件），**不进** team git sync。

### 7.2 Build config（桌面 onboarding 种子）

[`packages/app/src/lib/config/build-config.ts`](../../packages/app/src/lib/config/build-config.ts)
扩展：

```ts
localAgent?: 'opencode' | 'pi' | 'cursor'
```

[`create_backend()`](../../apps/daemon/src/runtime/backend.rs) 增加分支：

```rust
"cursor" => Box::new(super::cursor_sdk::CursorSdkBackend::new()),
```

### 7.3 前端设置

[`DaemonGeneralSection.tsx`](../../packages/app/src/components/settings/DaemonGeneralSection.tsx)
runtime picker 增加第三项 **Cursor (Composer)**；切换后 restart amuxd（与 pi 相同流程）。

[`LLMSectionRouter`](../../packages/app/src/components/settings/LLMSectionRouter.tsx)：
`local_agent === "cursor"` 时隐藏 Team LiteLLM / opencode provider OAuth 卡片，
改为 **Cursor API Key** 单行（写入 `[agents.cursor].api_key` 或引导用户设
`CURSOR_API_KEY`）。

### 7.4 Doctor / 安装

`amuxd doctor` 新增检查项：

- Node ≥ 20 可执行
- `cursor-bridge/node_modules/@cursor/sdk` 存在（或 bundled）
- `CURSOR_API_KEY` 有效（`Cursor.models.list()` 探针）
- 可选：Composer 账号是否有模型访问

安装路径对等 `opencode_install` / `pi_install`：

- `amuxd install-cursor-bridge` — npm ci bundled bridge
- Tauri sidecar 构建期打包 `cursor-bridge/` + `node`（或依赖系统 Node）

## 8. 与现有子系统的交互

| 子系统 | cursor 后端行为 |
|---|---|
| `ManagedLlmResolver` | **跳过** — Composer 计费走 Cursor key，不写 `provider.team` |
| `model-catalog.toml` | 正常写入，`provider_name = "cursor"` |
| `ModelMru` | 正常；`session_model()` 从 sidecar `get_agent_info` 读取 |
| workspace provider OAuth API | 返回 409 或空列表（cursor 不用 opencode providers） |
| cron workspace models | `model_catalog()` 走 Cursor.models.list |
| iOS | 无改动（读 `RuntimeInfo.available_models`） |
| gateway (WeCom 等) | 无改动（`RuntimeHandle` / `AcpEvent` 不变） |

## 9. 实施步骤

建议分 4 个 PR，每步可独立回归：

### PR 1 — 骨架 + 设计落地（本文件 + 工厂接线）

1. 本文档进 `docs/architecture/`
2. `runtime/cursor_sdk/mod.rs` 空实现 + `create_backend("cursor")`
3. `AgentsConfig` 增加 `[agents.cursor]` 结构体
4. build-config / 设置页 picker 增加 `cursor`（disabled preview 亦可）

### PR 2 — Sidecar + 最小 prompt 闭环

1. `apps/daemon/cursor-bridge/` — create/send/stream/wait/dispose
2. Rust `process.rs` + `client.rs` + 集成测试（mock sidecar stdout）
3. 桌面 tauri-mcp：单会话 prompt → 看到 streaming Output → Idle

### PR 3 — 完整 AcpEvent 面

1. `translate.rs` — tool use/result、error、StatusChange
2. `Cancel` / `SetModel` / `session_model`
3. Permission：hooks 或 SDK confirm 事件 → `ResolvePermission`
4. MCP mapper：workspace MCP → inline servers

### PR 4 — 产品化

1. `install-cursor-bridge` + doctor + Tauri 打包
2. resume 跨 daemon 重启
3. `DeviceModelCatalog` 持久化 + model picker 回归
4. 诊断报告 / Sentry 标签 `local_agent=cursor`

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| SDK public beta API 变更 | sidecar 独立版本锁；CI 用录制 JSON fixture 测 translate |
| Node 运行时依赖 | doctor 明确报错；长期可评估 Bun 编译 sidecar 单文件 |
| Composer 计费与团队 key 混用 | 第一版每设备一个 key；团队 service account 文档化 |
| MCP 不持久化 on resume | attach/resume/send 统一走 `assemble_mcp_inline()` |
| 权限语义与 opencode 不一致 | gateway 自动放行 + 桌面审批 UI 复用；差异写进 E2E |
| SaaS embedding 授权 | 产品化前联系 Cursor；文档标注「内部 / 自用」 |
| Cloud runtime 复杂度高 | 明确 out-of-scope v1；ID 前缀预留 `bc-` |

## 11. 最小验证脚本（开发期）

在 sidecar 落地前，可用独立脚本验证 key 与模型访问：

```typescript
// scripts/verify-cursor-sdk.mjs
import { Agent, Cursor, CursorAgentError } from "@cursor/sdk";

const apiKey = process.env.CURSOR_API_KEY;
if (!apiKey) throw new Error("set CURSOR_API_KEY");

const models = await Cursor.models.list({ apiKey });
console.log("models:", models.map((m) => m.id));

await using agent = await Agent.create({
  apiKey,
  model: { id: "composer-2.5" },
  local: { cwd: process.cwd(), settingSources: [] },
});

const run = await agent.send("Reply with exactly: pong");
for await (const ev of run.stream()) {
  if (ev.type === "assistant") {
    for (const b of ev.message.content) {
      if (b.type === "text") process.stdout.write(b.text);
    }
  }
}
const result = await run.wait();
if (result.status === "error") process.exit(2);
console.log("\nstatus:", result.status);
```

```bash
export CURSOR_API_KEY="cursor_..."
node scripts/verify-cursor-sdk.mjs
```

## 12. 参考

- 已有后端抽象：[`apps/daemon/src/runtime/backend.rs`](../../apps/daemon/src/runtime/backend.rs)
- Pi 对等实现：[`apps/daemon/src/runtime/pi_rpc/`](../../apps/daemon/src/runtime/pi_rpc/)
- Pi 设计稿：[`pi-agent-backend.md`](./pi-agent-backend.md)
- Cursor SDK skill（本地）：`~/.cursor/skills-cursor/sdk/SKILL.md`
- Cursor 文档：[TypeScript SDK](https://cursor.com/docs/sdk/typescript) ·
  [Composer 2.5](https://cursor.com/docs/models/cursor-composer-2-5)
