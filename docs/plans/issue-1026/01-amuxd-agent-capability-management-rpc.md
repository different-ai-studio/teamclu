# [P0][#1026] amuxd Agent 能力管理 RPC：本地 HTTP、远程 MQTT

父 Issue：#1026

## 背景

Skills/MCP 页面目前混用了 Cloud 安装记录、桌面端本机文件读写和 amuxd loopback
接口。这种实现只能管理当前电脑，无法可靠管理远程 Agent，也会让本地和远程产生两套
权限与状态语义。

仓库已有统一 `RpcRequest` / `RpcResponse` envelope：本机可经 `POST /v1/rpc`
进入同一 dispatch，远程可经 `amux/{team}/{actor}/rpc/req` 走 MQTT。本任务在这条
既有通道上增加 Agent 全局 Skills/MCP 管理 contract，不给远程 amuxd 暴露 HTTP。

## 目标

由目标 Agent 自己的 amuxd 提供一套传输无关的管理 service，作为该 Agent 实际安装
状态的权威来源：

- 本地 Agent：loopback HTTP。
- 远程 Agent：MQTT RPC request/response。
- 两种传输进入同一 handler/service，不复制业务逻辑。
- 只管理 Agent 全局能力；不读取或修改 workspace-local Skills/MCP。

## 范围

### 1. RPC contract

在 `proto/teamclu.proto` 的 RPC oneof 中增加成对 request/result，至少覆盖：

- 查询管理 capability/protocol version。
- 盘点 Agent 全局 Skills 的实际状态。
- 盘点 Agent 全局 MCP 配置及运行状态。
- 给 daemon 自己的 Actor 安装、卸载、重试团队 Skill。
- 给 daemon 自己的 Actor 安装、卸载团队 MCP，并刷新配置。
- 移除 Agent 的全局个人 Skill。
- 重试或刷新单个 MCP 的运行状态。

所有写请求沿用 envelope 的 `request_id`。amuxd 必须维护有界、带 TTL 的幂等结果缓存；
同一请求重发只能返回第一次结果，不能重复执行文件删除、安装或卸载。

### 2. 实际库存与最小暴露

Skills 盘点结果至少包含稳定 ID、名称、来源、版本、是否团队条目、健康状态和错误码。
个人 Skill 只返回元数据，不返回 `SKILL.md` 正文或附属文件。

MCP 盘点结果至少包含稳定 ID、名称、来源、transport、命令或 URL、配置状态、连接/认证/
启动状态和经过清洗的错误。`env` 与 headers 只能返回键名及“已配置/缺失”，不能返回值。
日志、MQTT payload diagnostics 和遥测同样不得记录秘密值。

内置 Skill/MCP 标记为只读。个人 Skill 可在在线状态下移除，但不能远程编辑或发布到团队。

### 3. 授权

只有目标 Agent 的 owner，或 `agent_member_access.permission_level = admin` 的成员可以调用
管理读写方法；`prompt` / `view` 一律拒绝。UI 过滤不构成安全边界。

当前 MQTT ACL 允许团队成员向团队内 Agent 的 RPC topic 发布，而 envelope 内的
`requester_actor_id` 是调用方填写的，不能单独作为写权限证据。实现必须使用 Cloud API
签发的短期、单目标、单 scope 管理 grant（或具备同等防伪能力的现有认证原语）：

- grant 绑定 team、requester Actor、target Agent、允许的方法、过期时间和 nonce。
- 不把用户 bearer token 转发给远程 Agent。
- amuxd 在执行前验证 grant；目标、scope 或请求身份不一致时 fail closed。
- 本地 HTTP fast path 也执行相同授权，不因 loopback 绕过 owner/admin 检查。

Cloud API contract 先写入 `docs/openapi/teamclu-api.v1.yaml`，再实现 FC route/repository；
客户端不得直连 Supabase。

### 4. 在线与 capability

管理 RPC 不创建离线队列。目标 Agent 离线或 MQTT 超时就明确失败，调用方不得把请求显示
为“待执行”。旧 amuxd 必须通过 capability/version 被识别；不支持新 contract 时返回
“需要升级 Agent”，不得回退到桌面端直接操作文件。

### 5. 成功语义

- Skill：下载、校验并落盘成功后，实际状态才是 installed。
- MCP：配置落盘即 installed；connected、needs-auth、failed 是独立运行状态。
- Cloud 期望已写入但实际安装失败时保留期望记录，盘点结果报告 drift/error，供后续重试
  或卸载；不要静默回滚用户意图。

## 不做

- 不做任何 Skills/MCP 页面改版。
- 不做公共 MCP 市场。
- 不管理 workspace-local Skills/MCP。
- 不远程编辑 Skill 文件，不远程发布个人 Skill。
- 不允许 Agent 通过本任务自主安装 MCP Server。
- 不给 amuxd 开公网 HTTP 监听。

## 验收

- [ ] 同一盘点请求经本地 HTTP 与远程 MQTT 返回等价结果。
- [ ] 两种传输命中同一 dispatch/service，并有 contract 测试锁定。
- [ ] 非 owner/admin、伪造 `requester_actor_id`、过期/错目标 grant 全部被拒绝。
- [ ] MQTT 重发同一 `request_id` 不会重复执行写操作。
- [ ] Agent 离线、RPC 超时和旧 capability 分别返回稳定、可展示的错误码。
- [ ] 盘点只包含全局能力；两个 workspace 中的本地条目不会混入。
- [ ] Skill 正文、MCP env/header 值不会出现在响应、日志或测试快照中。
- [ ] 内置条目无法移除；个人 Skill 移除需要显式写方法且可被幂等重试。
- [ ] Cloud 期望与实际状态不一致时返回明确 drift/error，而不是误报 installed。

## 主要落点

- `proto/teamclu.proto`
- `packages/app/src/lib/teamclu-rpc.ts`
- `apps/daemon/src/daemon/server/rpc.rs`
- `apps/daemon/src/http/rpc.rs`
- `apps/daemon/src/http/team_sync.rs`
- `apps/daemon/src/runtime/team_skills.rs`
- `apps/daemon/src/config/team_mcp.rs`
- `services/fc/src/lib/routes/actors.ts`
- `services/fc/src/lib/pg-repo/agents.ts`
- `docs/openapi/teamclu-api.v1.yaml`
