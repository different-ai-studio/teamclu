# Team MCP 公共清单 Implementation Plan

> **Superseded (ADR-0014, pi-only):** `mcp.opencode.generated.json` and
> `OPENCODE_CONFIG` injection were removed — Pi reads `state/cloud/mcp.json`
> directly. The SSOT and install flow below remain accurate.

> **For agentic workers:** 按本文件实现。禁止扩 scope。用户要求禁止过度设计。

**Goal:** Install 只给人记账；已装记录落到本机一份 Cursor 形状的公共清单；runtime 都读这一份；不再把团队 MCP 写入 workspace `opencode.json`。

**Architecture:** SSOT 是 `~/.amuxd/teams/<teamId>/state/cloud/mcp.json`，形状为 Cloud 已有的 `{ "mcpServers": { ... } }`（Cursor）。Daemon 用 daemon actor 拉 `/config` 经常是空的（无 FC 改 actor）——空结果不得覆盖已有缓存；全卸装靠 reconcile 返回 `{}`。~~OpenCode 读不了 Cursor 形状：同目录 `mcp.opencode.generated.json` **仅**给 `OPENCODE_CONFIG`~~（已删除，见 ADR-0014）。

**Tech Stack:** amuxd HTTP、desktop `team-share-browser`、现有 `sidecar/mcp.rs` / `team_cloud_config.rs`。

**不做：** FC / OpenAPI / actorId；`POST /mcp` 动态加服；杀 `opencode serve`；新抽象层；改 Pi 热更（仍 spawn 冻 env）。

---

## 文件

- Modify: `apps/daemon/src/runtime/team_cloud_config.rs` — 缓存写 Cursor 形状；空 fetch 不覆盖
- Modify: `apps/daemon/src/config/team_mcp.rs` — `read_cloud_mcp_file_into` 读 `mcpServers`
- Modify: `apps/daemon/src/runtime/sidecar/mcp.rs` — assemble 从 `mcpServers` 走 Cursor 转换（含 remote/`url`）
- Modify: `apps/daemon/src/runtime/pi_rpc/mod.rs` — team 层读同一份 `mcp.json`
- Modify: `apps/daemon/src/runtime/opencode_http/supervisor.rs` — spawn 始终 `OPENCODE_CONFIG` → generated
- Modify: `apps/daemon/src/runtime/opencode_http/client.rs` — `dispose_instance(directory)`
- Modify: `apps/daemon/src/http/team_sync.rs` + `routes.rs` — `PUT /v1/team/mcp-cache`
- Modify: `packages/app/src/lib/daemon-local-client.ts` — 客户端
- Modify: `packages/app/src/stores/team-share-browser.ts` — Install 写公共清单，删 `writeMcpIntoWorkspace`
- Test: 现有 `team_mcp.rs` / `sidecar/mcp.rs` / http 测试就地改；桌面 store 若已有测则改断言

---

### Task 1: 缓存保持 Cursor 形状，空不覆盖

`reconcile_mcp` 今天把 `/config` 转成 `{ "$schema", "mcp": ... }`。改成原样写 `{ "mcpServers": ... }`。

若 `mcpServers` 是空 object：若磁盘已有非空缓存，返回 `Some(false)` 且不写；仅当缓存不存在才写空。这样 daemon 身份拉到空列表不会抹掉桌面刚 PUT 的清单。

`read_cloud_mcp_file_into` 改为读 `mcpServers`，用已有 `CursorMcpServer` + `convert_cursor_server`。删掉「cloud 文件是 opencode `mcp`」注释。

`sidecar/mcp.rs` `assemble`：team 层解析 `mcpServers`（`CursorMcpServer` + `convert_cursor_server`）。**不要**用现有 `servers_from_mcp_config_value` 当 team 层解析——它会丢掉 remote/`url`。workspace `opencode.json` 仍作**用户本地 MCP**覆盖。Pi 同样：team 来自 `mcp.json`，workspace 只覆盖。

---

### Task 2: 桌面 PUT 公共清单

新增 `PUT /v1/team/mcp-cache`，scope `workspace:write`。Body：`{ "teamId"?: string, "mcpServers": { [name]: Cursor 条目 } }`。teamId 缺省走 onboarded team。写入走 `pub(crate) replace_team_mcp_cache`（SSOT + generated），不要在 `team_sync.rs` 复制写文件。然后对该 team 每个本地 worktree：`prune_materialised_team_mcp`；若 serve **已在跑**，`POST /instance/dispose?directory=<canonical>`（失败只 warn，不回滚；进行中的 session 可能被打断）。serve 没起来就不要 `ensure()`。

Desktop：`installMcp` / `uninstallMcp` / `updateMcp` / `deleteMcp` / list repair：

1. Cloud install/uninstall 不变
2. `listTeamMcpServers` 过滤 `installed`
3. 每条转 Cursor：stdio `{ command, args?, env? }` 或 remote `{ url, headers? }`（与 `/config` 相同，不要 `source`、不要 `command: string[]`）
4. `putTeamMcpCache(teamId, mcpServers)`
5. 删 `writeMcpIntoWorkspace` / `removeMcpFromWorkspace` / `repairMissingWorkspaceMcp` 对 `putDaemonMcp` 的调用。列表 repair 改为 PUT 缓存。

保留 `PUT workspace mcp` 给用户自己的 workspace MCP。Install 路径禁止再碰它。

---

### Task 3: OpenCode 只读 generated + dispose

`supervisor` spawn：**总是** `OPENCODE_CONFIG` = generated 绝对路径（缺则先写空 `{mcp:{}}`）。不要把 SSOT `mcp.json` 交给 OpenCode。其它 runtime 不读 generated。

`ServeClient` 加：

```
POST /instance/dispose?directory=<worktree>
```

清单写入后调用。不 `evict` 全局 serve。`RefreshChangeKind::Mcp` 的 `requires_provider_host_evict` 保持 false。

`convert_cursor_server` 已存在，generated 用它，不要新转换器。

---

## 验证

- 单元：cloud 文件只有 `mcpServers` 时 `scan_team_mcp` / `assemble` 能读到；空 reconcile 不擦非空文件
- 手测：Install → `mcp.json` 有条目、`opencode.json` 无该 team 名 → 新开 OpenCode session 能用（dispose 后）；Cursor/Claude 新 attach 能用

## 明确非目标

- 不改 Cloud API / FC
- 不把团队 MCP 再 materialize 进 workspace
- 不为 Pi 做 live env 替换
- 不引入第三种 MCP schema
