# 自动且不可变的会话 Workspace

- **Date**: 2026-09-14
- **Status**: DESIGN — 待评审
- **Scope**: 会话 workspace 身份、创建时固化、启动时只读、Desktop 自动绑定、Cloud API / FC / daemon 校验。不改 pi 进程池、不改 team sync 树。
- **Non-scope**: 显式「修复目录绑定」产品、把 cron 调度器搬到 daemon、1 team = 1 workspace、消息 dedup 状态机（独立 PR）、realpath / 软链展开。
- **Supersedes**: [`2026-09-14-single-workspace-migration-boundary.md`](2026-09-14-single-workspace-migration-boundary.md)（1 team = 1 workspace）。那份草稿把身份收成团队的一个家；本次事故说明用户要的是当前窗口项目，不是团队默认家。两边都删选择器，绑定来源相反，不能并行落地。
- **Related**: ADR-0005（participant 带 workspace）、[`docs/workspace-local-cloud.md`](../workspace-local-cloud.md)、[`docs/specs/2026-06-18-session-viewer-workspace-design.md`](2026-06-18-session-viewer-workspace-design.md)、[`docs/adr/0012-window-local-state-is-the-default.md`](../adr/0012-window-local-state-is-the-default.md)

---

## 0. 一句话

产品上不让用户为会话选择 workspace。系统根据创建时的项目上下文自动绑定，并且绑定后保持不变。Agent 可以拥有多个 workspace，每个 session 只能有一个权威 workspace。

这同时修掉「Copilot 361 找不到 → 落到 TeamClaw」的双绑定，并保留多项目、多窗口和历史会话。

## 1. 决策

| # | 决定 | 理由 |
|---|---|---|
| D1 | Agent 可有 N 个 workspace；每个 session/agent 一个不可变绑定 | 多项目是真需求；双绑定来自启动时再推断 |
| D2 | 用户创建会话时不选 workspace | 选择器是事故源：空列表 + `bound[0]` fallback |
| D3 | Desktop 绑当前窗口的**项目根**（`useWorkspaceStore.workspacePath`），不是任意子目录 | 打开 `…/Copilot 361/ios` 不应裂出新 UUID；子目录只是文件树 cwd |
| D4 | 无路径客户端用 `agents.default_workspace_id`，创建时固化 | iOS / Expo / Web / Cron / 远程入口没有窗口目录 |
| D5 | 已有会话只读 `session_participants.workspace_id` | 当前窗口、设备 cache、上次 runtime 都不得覆盖 |
| D6 | 云端唯一键是 `(team_id, path_key)`，**不含** `agent_id` | 同一绝对路径只应有一个有效 UUID；`agent_id` 是归属，不是身份 |
| D7 | `path_key` 首期只做字符串规范化，不做 realpath / 软链展开 | `/var` vs `/private/var` 会再拆一个 UUID |
| D8 | Apps 走 checkout 路径，不走当前窗口路径 | 从 TeamClaw 窗口打开 App 不能绑到 TeamClaw |
| D9 | 文件树仍 viewer-scoped；runtime 目录不可用则明确失败 | 打开别人的会话不得 `setWorkspace` 外机 path |
| D10 | 有 path 的 workspace 禁止 `prefer_client_worktree` | daemon 侧的静默回退，和 `bound[0]` 同类 |
| D11 | `rememberDefaultWorkspaceId` 退出已有会话路径 | 设备级 cache 会跨窗口污染 session binding |
| D12 | 已写入的 Agent participant `workspace_id` 不可被普通 upsert 覆盖 | join / 同步 / runtime 更新不能改绑定 |
| D13 | `workspaceByActorId` 只填本机 daemon；远程 Agent 固化各自 default | 窗口路径是这台机器的，不能交给远程 daemon |
| D14 | 创建响应返回实际 binding；本地 cache 只用响应值 | 今天 cache 用请求参数拼装，会出现 ID/path 错配 |
| D15 | 本地 binding `ready` 之前禁止 first send / focus-wake / fast runtime start | 否则两条路径各拿一个 ID |
| D16 | 不合并 TeamClaw / TeamClu Dev / Copilot 361 | 它们是不同项目；只清理错误绑定 |
| D17 | 消息可靠性（pending prompt / dedup / draining）独立 PR | 能挡住本次 supersede，但修的是另一类故障 |

## 2. 核心模型

```text
Agent
  ├─ default_workspace_id     仅用于没有项目上下文的创建
  ├─ Workspace A  TeamClaw
  ├─ Workspace B  TeamClu Dev
  └─ Workspace C  Copilot 361

Session 1 → Workspace A
Session 2 → Workspace B
Session 3 → Workspace C
```

三层不要再焊在一起：

| 层 | 含义 | 载体 |
|---|---|---|
| 会话绑定 | 这个 session 里这个 Agent 跑哪 | `session_participants.workspace_id`，创建后不可变 |
| 目录身份 | 这个 team 在这台机器上的这个文件夹 | `amux.workspaces.id`，按 `(team_id, path_key)` 去重 |
| 窗口 cwd | 这个窗口文件树 / 终端当前站在哪 | `useWorkspaceStore`；可以是绑定根下的子目录，不创造新 row |

`agent_id` 仍写在 workspace 行上，用于「这个目录登记在哪个 Agent 名下」和创建会话时的归属校验。它不是去重键。

## 3. 产品行为

### 3.1 Desktop 当前有项目目录

窗口项目根：

```text
/Users/weigan.huang/Copilot 361
```

新会话自动绑定该根对应的 workspace UUID。用户看不到、也不能选 workspace。

新会话界面只读展示：

```text
工作目录：Copilot 361
```

不是选择器。没有列表、没有「设为默认」、没有浏览其他目录、没有落到第一条 workspace。

文件树钻进子目录不改变将要创建的会话绑定。若用户把**窗口本身**开在某个子文件夹上，那一层就是这个窗口的项目根（C 的本意：认窗口登记根，不认任意 cwd）。

### 3.2 当前目录尚未注册

1. 按 `team_id + path_key` 精确查找有效 row。
2. 找不到则幂等创建（`agent_id` = 本机 daemon）。
3. 用这个 ID 创建会话并固化 participant。
4. 禁止回退到 Agent 第一条 workspace、上次打开的 workspace、另一个窗口的 cache。

```text
错误：Copilot 361 找不到 → bound[0] → TeamClaw
正确：Copilot 361 找不到 → 创建 Copilot 361 workspace → 绑定新 ID
```

历史脏数据里同一 `path_key` 可能有多行（不同 `agent_id`）。查找时优先本机 daemon 那一行；唯一约束落地后迁移合并，不靠新索引把它们合法化。

### 3.3 没有项目目录的客户端

iOS、Expo、Web、远程聊天入口、Cron、不关联本地窗口的会话：使用 `agents.default_workspace_id`，创建时写进 participant。之后改 Agent 默认值，旧会话不跟着变。

### 3.4 重新打开历史会话

始终使用创建时绑定的 workspace。当前窗口、Agent 默认、其他窗口最近启动过什么，都不参与。

### 3.5 Workspace 不存在或目录被移动

不允许回退到默认 workspace，不允许改用当前窗口目录。runtime 启动失败，明确状态：

```text
该会话的工作目录不可用
原目录：/Users/.../TeamClaw
```

「修复目录绑定」是后续独立功能，必须显式用户操作，不能静默修复。

### 3.6 打开他人会话（文件树）

[`2026-06-18-session-viewer-workspace-design.md`](2026-06-18-session-viewer-workspace-design.md) 仍有效：聊天能看，窗口文件树不得 `setWorkspace` 成外机绝对路径。本机若要启动自己的 Agent，走 D5；path 在这台机器上不可用则走 3.5，而不是换一个目录把 Agent 拉起来。

## 4. 权威优先级

### 4.1 创建新会话

Desktop / Apps：

```text
给定的项目根路径（窗口根，或 App checkout）
  → 已存在 workspace：用其 ID
  → 不存在：创建
  → 创建 session，固化 participant.workspace_id
```

无路径客户端：

```text
agent.default_workspace_id
  → 创建 session，固化 participant.workspace_id
```

解析与创建只允许出现在这条「新会话」路上。函数：`ensureWorkspaceForNewSessionContext`。它可以创建 workspace。

### 4.2 已存在会话启动

唯一合法来源：

```text
session_participants.workspace_id
```

本地 cache 没有 → 读 Cloud participant。Cloud 也没有 → `SESSION_WORKSPACE_UNBOUND`，停止。不得继续推断。

函数：`resolveBoundWorkspaceForExistingSession`。绝对不能创建 workspace，不能读窗口路径，不能读 `cachedDefaultWorkspaceId`，不能读 `bound[0]`，不能接受调用方更高优先级的 `workspaceIdHint` 覆盖它。

## 5. 创建会话完整链路

```text
用户点击创建
  │
  ├─ 取当前窗口项目根（Apps：取 checkout 路径）
  ├─ 取本机 local daemon actor ID
  ├─ ensureWorkspaceForNewSessionContext(teamId, path)
  │    ├─ 按 (team, path_key) 精确匹配
  │    └─ 不存在则幂等创建（agent_id = 本机 daemon）
  ├─ createSession({ workspaceByActorId: { localDaemonId: workspaceId } })
  ├─ Cloud API 校验并写入 session_participants.workspace_id
  ├─ Cloud API 返回实际 participantWorkspaces
  ├─ 客户端用响应值写入 local-cache（禁止用请求参数拼装）
  ├─ workspaceBindingState = ready
  ├─ 切换到新会话
  └─ 发送第一条消息
```

第一条消息和 session focus 发生前，本地必须已经拿到 Cloud 确认后的 binding。fast-send 和 focus-wake 读同一份 ID。

`createSessionShell` 今天 POST 之后只返回 `{ sessionId: input.id }`，连响应体里的 binding 都丢了。这一步必须改。

## 6. Cloud API

### 6.1 Workspace 精确注册

继续 `POST /v1/workspaces`：

```json
{
  "teamId": "...",
  "agentId": "...",
  "name": "Copilot 361",
  "path": "/Users/weigan.huang/Copilot 361"
}
```

幂等键：`team_id + path_key`（规范化后的路径）。并发同一路径只返回同一个 workspace ID。

今天 `upsertWorkspace` 已按 `(team, path)` 复用，不看 agent。要做的是把这层应用层去重升级成 unique index，并改用 `path_key`，**不要**改成 `(team, agent, path)`。

`agent_id` 仍写入行：新行用请求里经服务端解析的本机 daemon；复用已有行时不改归属（避免两台机器/两个 Agent 抢同一行的 path——路径不同本来就不会撞；路径相同则本来就是同一目录）。

查找可以带 `agent_id` 做脏数据消歧，唯一约束不能带它。带上会允许：

```text
Agent A + /Copilot 361 → ws-1
Agent B + /Copilot 361 → ws-2
```

这是要消灭的双 UUID。

### 6.2 `path_key` 首期规则

对客户端传入的 path：

1. trim
2. 去掉尾部 `/`（根 `/` 除外）
3. 折叠重复分隔符
4. 解析 `.` 和 `..`

不做：realpath、软链展开、macOS 大小写折叠。那些会把窗口报告的路径和磁盘真实路径拆成两个 ID。大小写与软链若要做，必须另开迁移。

现有 `normalizeWorkspacePath` 只去尾 `/`，在此基础上扩展，结果同时写入 `path`（展示/解析用）和 `path_key`（去重用）。首期两者可以相同。

### 6.3 创建会话

保留内部字段 `workspaceByActorId`。它是客户端自动生成的运行上下文，不是用户选择结果。

FC 必须验证每一对 `(actorId, workspaceId)`：

- Actor 是该 session 的 Agent participant
- Workspace 属于同一 team
- `workspace.agent_id` 等于该 Actor ID
- Workspace 未归档
- Workspace path / `path_key` 非空

验证失败则**整次创建失败**。不能忽略字段后改用 default。缺字段的无路径客户端才走 `agents.default_workspace_id`。

「path 非空」只约束显式传入的 `workspaceByActorId`（Desktop / Apps 一定带本机目录）。走 default 时允许仍是尚未 bind path 的 `"General"` 占位行——那些客户端不在本机起 runtime。Desktop 有窗口路径时禁止把会话绑到占位行。

今天 `workspaceIdByAgentActor` 只做 override-or-default，没有任何归属校验。

### 6.4 创建响应

当前响应实质上只有 `sessionId`。扩展为：

```json
{
  "sessionId": "...",
  "participantWorkspaces": {
    "<agent-id>": {
      "workspaceId": "...",
      "workspacePath": "/Users/weigan.huang/Copilot 361"
    }
  }
}
```

`workspaceId` 和 `workspacePath` 必须来自同一条 Cloud workspace row。客户端 cache 只许写这对值。

涉及：`docs/openapi/teamclu-api.v1.yaml`、`packages/app/src/lib/backend/cloud-api/sessions.ts`、`services/fc/src/lib/supabase-repo.ts`（`createSession`）。

### 6.5 Participant 绑定不可变

`joinSession`、cron bootstrap、`onConflict: session_id,actor_id` 的普通 upsert **不得改写**已有 Agent participant 行上的 `workspace_id`（包括把 NULL 填成 default——那会让旧会话静默落到 TeamClaw）。

- **新插入**的 Agent participant：创建时写入绑定（Desktop/Apps 用 ensure 结果，无路径用 default）
- **已存在**的行：`workspace_id` 原样保留；NULL 保持 NULL，启动走 `SESSION_WORKSPACE_UNBOUND`（§11）
- 未来「迁移会话工作目录」才是唯一 UPDATE 入口，且必须是显式用户操作

## 7. 数据库

### 7.1 Workspace 唯一性

```sql
CREATE UNIQUE INDEX workspaces_team_path_unique
ON amux.workspaces (team_id, path_key)
WHERE archived = false
  AND path_key IS NOT NULL;
```

不是限制一个 Agent 只有一个 workspace，而是限制同一路径只有一个有效 row。现有 `(team_id, agent_id, name)` 唯一约束保留（名称展示仍要唯一）。

`path_key` 为 NULL 的占位行（团队 mint 的 `"General"`）不进这个索引。Desktop 有窗口路径时禁止绑到这种占位行。

两台 Mac 路径不同，自然两行，不 last-writer-wins。这是 Apps 已经踩过、且必须继续躲开的坑。

### 7.2 Participant 跨表不变量

PostgreSQL CHECK 不能可靠表达跨表关系。在事务函数或 trigger 中保证：

```text
session participant actor_id  →  workspace.agent_id 相同
session.team_id               →  workspace.team_id 相同
```

配套 pgTAP。成员 participant 的 `workspace_id` 继续为 NULL。

## 8. Desktop

### 8.1 新会话界面

从 `NewSessionDialog.tsx` 删除：workspace 列表、下拉、设为默认、浏览其他目录、`workspaces[0]` fallback。保留只读当前窗口项目根。

设置页仍可管理 workspace（改绑、归档），但不参与会话选择。iOS / Expo 的选择器随产品收敛 PR 一起去掉，无路径时走 D4。

### 8.2 拆两条解析函数

删除 `resolveCloudWorkspaceIdForAgents` 的 `bound[0]`，以及 `ensureCloudWorkspaceIdForAgentRuntime` 里「先 live（含 fallback）再创建」的顺序——那会让创建永远走不到。

```ts
ensureWorkspaceForNewSessionContext(...)
  // 有路径：精确匹配或创建。有路径就不能走 Agent default / owned fallback。
  // 无路径：不在这条函数里处理。

resolveBoundWorkspaceForExistingSession(...)
  // 只读 participant（cache → Cloud）。失败返回 unbound，不创建、不猜测。
```

`resolveLiveWorkspaceHint` / `resolveSessionWorkspaceHintForRuntimeStart` / `resolveAgentRuntimeWorkspaceId` 这条优先级链（caller hint → session runtime → default → owned）对**已有会话**全部作废。

### 8.3 本地缓存

禁止再出现：

```text
workspace_id   = TeamClaw ID
workspace_path = Copilot 361 path
```

规则：

- ID 和 path 必须来自同一条 Cloud workspace response
- 不接受分别从两个来源拼装
- upsert 前校验当前 session participant 的 workspace ID
- cache key = `sessionId + agentId`
- Cloud binding 与 cache 不一致时以 Cloud 为准并覆盖，记 mismatch 诊断事件
- `agent-default-workspace-store` 不得作为已有会话的 fallback；最多在无路径**创建**时使用

### 8.4 新会话导航时序

```text
create session
→ persist authoritative binding
→ workspaceBindingState = ready
→ activate session
→ start runtime / send message
```

```ts
workspaceBindingState: 'resolving' | 'ready' | 'failed'
```

只有 `ready` 才允许：fast local runtime start、focus wake、发送首条 Agent prompt。

Apps 已有 `waitForAppSessionSetup`；普通会话要对齐同一类门闩，不能「先切过去再后台绑」。

### 8.5 创建上下文从哪来

| 入口 | 路径来源 |
|---|---|
| Desktop 新会话 / composer 快建 | 当前窗口 `workspacePath`（项目根） |
| Apps 打开 / 创建会话 | 该 App 本机 checkout，走现有 `ensureAppWorkspaceRow` |
| Cron | 请求里的 `workspaceId`，否则 Agent default |
| iOS / Expo / Web / 远程 | Agent default |

## 9. Runtime 启动统一

`ensure-agent-runtime.ts` 成为已有会话的唯一 workspace 决策入口。调用方只传 `sessionId + agentId`。

来源：fast-send、session focus、reconnect、retry、mention、ChatPanel recovery、embedded session。

不允许调用方传一个优先级更高的 `workspaceIdHint` 覆盖 participant 绑定。出站队列里的 hint 若存在，只能作为诊断；与 binding 不一致则拒绝并记 mismatch。

### Fast path

可以继续存在，但只能使用已经写入并校验过的 session cache：

```text
cache hit 且已验证 → 立即启动
cache miss → 等待 / 拉取 participant
```

不能使用：`cachedDefaultWorkspaceId`、当前窗口 path、`entry.workspaceIdHint`、owned workspace、previous runtime workspace。

涉及 `packages/app/src/services/outbox-sender.ts`、`startAgentRuntimesAsync` 的 `workspaceIdHint`。

## 10. Daemon

收到 `sessionId + agentId + workspaceId` 后必须能把 workspace 解析为 path。

已有 runtime：

- workspace ID 相同：复用
- workspace ID 不同：先查 session participant 权威绑定
- 请求值 ≠ participant binding：拒绝，记 mismatch
- 不允许「最后一次 runtimeStart 获胜」

错误类型：

```text
SESSION_WORKSPACE_UNBOUND
SESSION_WORKSPACE_MISMATCH
WORKSPACE_NOT_FOUND
WORKSPACE_PATH_UNAVAILABLE
```

`worktree` 只保留兼容性：

- **有 path 的 workspace**：忽略客户端 worktree，path 本机不存在则 `WORKSPACE_PATH_UNAVAILABLE`。删除 / 禁用 `prefer_client_worktree`。
- **无 path 的 Apps 占位行**（尚未 bind 本机目录）：仍可用客户端 worktree，直到 `ensureAppWorkspaceRow` 把 path 写上。这是过渡，不是已有用户会话的回退。

## 11. 现有数据

不合并 TeamClaw、TeamClu Dev、Copilot 361。只清理错误数据。

可自动修复：

- 完全相同 `path_key` 的重复 workspace row（含不同 `agent_id` 的重复）→ 留一行，改写引用
- Cloud participant 有权威绑定但 local cache 不一致 → 以 Cloud 覆盖
- 默认 workspace 缺失且该 Agent 只有一个合法有 path 的 workspace → 补 default（仅 default，不改旧 session）

需人工确认：

- 一个 session 历史上先后跑过多个不同路径
- participant binding 缺失，同时 Agent 有多个 workspace
- Cloud binding 与真实项目无法根据路径确定

本次出事故的 session：按创建时窗口路径和诊断时间线，应修成 Copilot 361 对应 workspace（没有则创建），不是 TeamClaw 或 TeamClu Dev。这是一次性数据修复，不进产品静默路径。

Participant `workspace_id` 为 NULL 的旧会话：启动返回 `SESSION_WORKSPACE_UNBOUND`，不自动猜。补齐走运维/一次性脚本，或未来的显式修复 UI。

## 12. 测试矩阵

### Workspace 解析（新会话）

- 当前路径已有 workspace：复用同一 ID
- 当前路径不存在：创建新 ID，不得返回 `bound[0]`
- Agent 有多个 workspace：当前路径是 Copilot 361 时不得返回 TeamClaw
- 两个并发创建同一 path：同一个 ID
- 路径尾部斜杠不同：同一 workspace
- 窗口文件树位于子目录：仍绑窗口项目根，不新建
- Apps checkout：绑 checkout，不绑当前窗口

### Session 创建

- Desktop 自动绑定当前窗口项目根
- 新会话 UI 没有 workspace 选择
- Cloud 校验 workspace 所属 Agent；失败则创建失败
- Cloud 返回实际 participant binding
- 本地缓存使用响应值，ID/path 同源
- 本地绑定未 `ready` 时不发送第一条 prompt
- 无路径客户端绑定 Agent default；之后改 default 不影响旧 session
- 远程 Agent 不绑窗口路径

### 多窗口

```text
窗口 A：TeamClaw
窗口 B：Copilot 361
```

- Session A 始终 TeamClaw，Session B 始终 Copilot 361
- 两个窗口的 default cache 不互相覆盖 session binding
- focus 切换不改变已有会话 workspace

### 已有会话启动

- fast-send 和 focus-wake 使用同一个 ID
- cache miss 等 Cloud，不 fallback
- 绑定目录不可用：明确失败，不换目录
- 并发 ensure 只产生一个有效 runtime
- 请求 workspace ≠ participant：daemon 拒绝

### 回归

- 打开他人会话不 `setWorkspace` 外机 path
- 两个不同 cwd 的 pi host 不共享进程
- Apps checkout 根上仍然没有 `team-knowledge` 链接
- team sync 仍只扫 `shared/team-sync/`

## 13. PR 切分

四个 PR。**1 和 2 必须能在同一发布窗口落地**：只删 `bound[0]`、启动仍在猜，中间态会继续双绑定。

1. **Workspace exact resolution**
   - 删除 `bound[0]` 及「有路径仍 fallback」
   - `path_key` + `(team_id, path_key)` 幂等
   - `ensureWorkspaceForNewSessionContext` / `resolveBoundWorkspaceForExistingSession` 拆开
   - 已有会话缺绑定即 `SESSION_WORKSPACE_UNBOUND`（不要等 PR2 才禁止 fallback）
   - 测试：Copilot 361 不得落到 TeamClaw

2. **Authoritative session binding**
   - Cloud 校验 `workspaceByActorId`；创建响应带 `participantWorkspaces`
   - 本地 cache 只用响应值；ID/path 同源校验
   - `ensure-agent-runtime` 成为已有会话唯一入口；去掉 hint 覆盖
   - readiness gate
   - participant `workspace_id` 不可被普通 upsert 覆盖
   - daemon：有 path 则禁用 `prefer_client_worktree`；mismatch 拒绝

3. **Remove session workspace picker**
   - 新会话只读展示当前工作目录
   - iOS / Expo / Web 无路径走 default
   - 设置页仍可管理 workspace，不参与会话选择

4. **Daemon prompt reliability**（独立）
   - pending prompt 纳入 busy
   - dedup 状态机；runtime 异常退出释放 reservation
   - runtime draining
   - delivered/no-turn 回归

PR1+PR2 修掉双 workspace 绑定。PR3 是产品体验。PR4 挡住模型切换、重连等其他原因再次 delivered/no-turn。

## 14. 验收

- 用户创建会话时不需要选择 workspace
- 当前窗口路径没有 Cloud row 时自动创建，不能选成别的 workspace
- 每个 Agent 可以服务多个项目
- 每个 session/agent 只有一个不可变 workspace binding
- 历史会话不受 Agent 默认值变化、当前窗口、其他窗口 cache 影响
- 子目录浏览不裂变新 workspace
- Apps 会话绑 checkout，不绑当前窗口
- fast-send、focus-wake、reconnect 使用完全相同的 workspace ID
- 本地 cache 不可能保存 ID/path 不匹配的组合
- workspace 不可用时明确失败，不静默回退
- 同一 `(team, path_key)` 不会产生两个有效 UUID（即使 agent 不同）
- 本次 `Copilot 361 → TeamClaw / TeamClu Dev` 复现场景有端到端测试

## 15. 明确不在本 spec

- 1 team = 1 个用户可管理的 workspace（已否决，见文首 Supersedes）
- 把所有 Agent 工作强制进 `~/.amuxd/teams/<id>/workspace`
- 多窗口只能开同一个目录
- 显式「修复 / 迁移会话工作目录」UI
- realpath、软链、大小写折叠
- 删 `amux.workspaces` 或去掉 `(team_id, agent_id, name)` 名称唯一
- 把 cron 调度器从桌面搬到 daemon（ADR-0010 正文）
- 消息生命周期状态机（PR4，可并行设计，不堵 PR1/2）
