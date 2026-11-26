# App 平台 P2.5：`amuxd app` CLI 接管，`manage_app*` MCP 退役（实施计划，草案）

- 父 spec：`2026-11-24-app-platform-infra-decoupling-design.md` §7（CLI 规范 C1–C10、审批 §7.5、退役清单 §7.6）。
- 命令树：`2026-11-24-amuxd-app-cli-design.md`（Q1–Q23 已拍板）。
- 平台侧依赖：P2（PR #2016，Delegation、`caller_app_access`）、P3（`app_links` / `app_grants` / `app_forge_repos`）。
- **状态：2026-11-26 草案，§4 的问题待拍板。**

## 0. 目标与退出标准

**目标**：agent 只用 `amuxd app` 管理应用；桌面 `manage_app*` 7 个工具和 `introspect_api/apps*` 删除；高危操作的审批由 amuxd 发起，在会话里裁决。

**退出标准**（父 spec §8 P2.5）：
1. 新会话的系统提示词里没有 `manage_app*`，只有一行指向 `amuxd app --help`。
2. 只装 amuxd（不开桌面）的 agent 能走完：建 app → 部署 → 改 env → 看日志。
3. ⚠ 操作（deploy、undeploy、delete、access grant/revoke、domain set/rm、gate 改公开、files purge）由 agent 发起时在会话里审批；full-access 和 cron / 渠道会话都不豁免。
4. `teamclu-introspect` 里 grep 不到 `manage_app`；桌面 `introspect_api/apps*` 和对应确认弹窗删除。

## 1. 现状（2026-11-26，main `86f0a98df`）

### 1.1 能力覆盖

| 组 | `manage_app*`（桌面，真人 bearer） | `amuxd app` CLI / `/v1/app-ops`（daemon 的 agent 账号） | `teamclu-apps` crate |
|---|---|---|---|
| 生命周期 15 个 action | 全部 | 10 个：list、status、create、update、reseed、download、deploy、logs、undeploy、delete | 同 CLI |
| 生命周期缺的 | — | deploy_status、auth_info、runtime_info、sessions、move_workdir | 无（桌面直连 Cloud API） |
| access / data / files / env / cron / domain | 全部 | **无** | **无**（桌面直连 Cloud API，约 1,600 行） |

规模：sidecar 工具定义和 files 约 1,480 行；桌面 handler 约 2,800 行；确认弹窗约 1,400 行，其中 `mcp_servers_replace` 不属于 app，要保留。

### 1.2 CLI 离规范多远

- 输出：成功打印裸 JSON，失败打印 `{"ok":false,"error":"<字符串>"}`，退出码一律 1。没有 `"v": 1` 外层，没有错误码 / `next` / 退出码表 / 输出上限 / `-o table`。
- 鉴权：读 `amuxd.http.token`（root token），换取 TCP 会话 token。agent 和人用同一个系统账号，agent 能读这个文件。
- 审批：`CliHost::approve_deploy` 恒为 `false`，没有任何审批。

**已经存在的漏洞**：agent 今天就能在 bash 里跑 `amuxd app deploy` / `delete`，绕过桌面弹窗，因为 CLI 没有审批。P2.5 不只是迁移，也是补这个洞。

### 1.3 可复用的基础设施

| 需要 | 现状 |
|---|---|
| 按进程祖先认 agent | ✅ 有：`proc_tree.rs` + `HostProcessRegistry::find_in_chain` + 0600 的 `runtime-context.sock`（`peer_cred`）。但只挂了 `/internal/runtime-context/cloud-token` 一条路由；只有 pi host 会注册 |
| TCP 写请求 403 | ✅ cloud-token 已有同样做法（`runtime_context.rs:228-236`） |
| 会话 ↔ host 核对 | 部分：`context_registry.rs:176-235` 按 pi 的 backend session id 查 TeamClu 会话；缺「TeamClu 会话 id → 是否属于这个 host」的反查 |
| bash 里的 `TEAMCLU_SESSION_ID` | ❌ 常量有，但没人设置。host 环境变量按 host 只建一次，bash 工具在外部包里，扩展没有包装它 |
| 会话内审批 | 部分：`AcpPermissionRequest` / `PermissionManager` / 聊天 `/allow` 是通用的，但发起方只有 pi 的 `ctx.ui.confirm`，裁决结果回到 runtime 自己的 resolver |
| 批准人资格 | ❌ 授予 / 拒绝不检查身份；聊天里任何人都能 `/allow` |
| 审批超时 | ❌ daemon 侧没有，随轮次 / 会话结束 |
| 主人收件箱 + 手机推送 | ❌ APNs 只在插入消息时触发；没有「agent → 主人」的个人会话，也没有「找 agent 的主人」的接口 |
| Windows 认人 | ❌ 沿用 TCP bearer |

## 2. 步骤

每步单独合并。S1–S4 完成之前 MCP 不动，保证随时都有一条带审批的路径。

| 步 | 内容 | 依赖 | 规模 |
|---|---|---|---|
| **S1 CLI 契约底座** | `{"v":1,"ok",…}` 外层、错误 `code/message/next/retryable`、退出码表 0/2–9、输出上限和截断游标、`-o table`、`-o file:`、`whoami`、`--help` 规范；现有 9 条命令按 Q7 改参数（`--visibility` → `access --org`、`--auth-*` → `gate`、`--git-remote/--dir` → `--from-git/--from-dir`、`--since`）；CLI 契约测试 | — | 中 |
| **S2 补齐命令** | `teamclu-apps` 增加 access / gate / env / data / files / cron / domain / runtime / sessions / `checkout move\|bind`，挂到 `/v1/app-ops` 和 CLI。桌面 `settings.rs` / `data.rs` / `files.rs` 的逻辑搬进 crate，桌面 handler 先改为调用 crate（行为不变，为 S6 铺路）。可拆成 S2a（只读 + env / cron / data / domain）、S2b（files，CLI 进程里直接传字节）、S2c（access / gate） | S1 | 大 |
| **S3 认人** | `/v1/app-ops` 挂上 `runtime-context.sock`（或一个新的 0600 socket）：对端 pid → 祖先链 → agent host / 真人；unix 上 TCP 写请求 403；Windows 用 TCP bearer + 代次；`whoami` 说明判断依据 | S1 | 中 |
| **S4 审批**（拆三块） | **S4a op 注册表**：deploy / undeploy 由 amuxd 执行，CLI 只等待；`op status/wait/list`、`--detach`、退出码 8 表示「结果未知」。**S4b 会话内审批**：注入 `TEAMCLU_SESSION_ID`、会话归属核对、amuxd 作为非 pi 发起方发 `AcpPermissionRequest`、有自己的 resolver、批准人资格（真人 + 对 app 有 admin）、10 分钟超时、批准后重新预检、full-access 不放行。**S4c 主人收件箱**：定位不到会话时转给主人，24 小时超时，桌面 + 手机推送 | S3 | 最大 |
| **S5 切换文案** | 系统提示词一行；`deploy-app` / `app-auth` skill、`app-deploy-prompt.ts`、locale、`app_build.rs` / `app-runtime-spec.ts` 里的错误文案改成 `amuxd app`；`teamclu-apps` 的 `Surface` 统一为 CLI；更新钉住文案的测试 | S2、S4b | 小 |
| **S6 删除** | 删 `teamclu-introspect` 的 `manage_app*`、桌面 `introspect_api/apps*` 和 app 相关确认弹窗（保留 `mcp_servers_replace`）、`caller.rs` 里 app 路由的条目 | S5 | 中（主要是删） |

S2 和 S3 可以并行。按 §1.2 的漏洞，**S3 + S4a/S4b 对 deploy / delete 的部分可以先做**，不必等 S2 全部完成。

## 3. 设计稿写完之后变了的前提

- **Delegation 的上限**：CLI 设计 Q10 写的是「Delegation 封顶 write → agent 不能部署主人的 app」。P2 实际落地的是 P2 Q1「委托权限最高到部署，不能管理授权、不能删 app」：`caller_app_access` 给主人 app 的委托级别可以到 admin，FC 用 `assertNotInheritedFor` 挡住 delete 和授权管理。两者不一致，见 §4 Q1。
- **visibility**：CLI 设计 Q11 取消 `visibility`，改用 `access grant --org`。P3 Q1 保留了 `/v1` 的 `visibility` 字段（由 org 授权推导）。CLI 的 `access grant --org read` 可以落到 PATCH visibility=team，`revoke --org` 落到 personal；`--org write` 平台允许（`app_grants_org_level`），但现在没有接口。
- **身份**：`manage_app` 用登录真人的 bearer，CLI 用 agent 自己的账号。切换后 agent 看到的 app 少了：主人的个人 app 只能通过 Delegation 看到。agent 建的 app 归 agent；Delegation 是「agent 按主人的级别行事」，反过来主人看不到 agent 的 app，除非 agent 授权给他。

## 4. 待拍板

1. **Delegation 上限按哪个算？** (a) 按已上线的 P2 Q1：agent 可以部署主人的 app，但部署要审批（推荐，审批本身就是闸门）；(b) 按 CLI 设计 Q10 封顶 write：要改 `caller_app_access` 和 FC。
2. **`TEAMCLU_SESSION_ID` 怎么进 bash？** 一个 host 同时跑多个会话，host 级环境变量不行。候选：(a) 扩展在 `tool_call` 钩子里给 bash 命令前面加 `export TEAMCLU_SESSION_ID=…;`（改写 `input.command`，最简单，但改了 agent 看到的命令）；(b) 上游 pi 包支持按调用传 env；(c) 不注入，amuxd 用「这个 host 当前正在执行 bash 的会话」反推（多个会话同时跑 bash 时会歧义）。推荐 (a)，要先确认 pi 的 `tool_call` 钩子能改写参数。
3. **主人收件箱（S4c）第一期做不做？** 不做的话，定位不到会话的审批（脱离会话的后台进程）直接拒绝（退出码 9）。cron 和渠道会话本身有会话，仍然能在会话里审批，只是可能没人看、10 分钟后超时。推荐第一期不做，等有真实需要再做。
4. **终端里的真人身份（Q9）**：设计稿说「真人凭证（桌面端登录时写下）」，这套机制还不存在。S3 一上线，unix 上 TCP 写请求就会 403，真人在终端里的写操作会断掉。候选：(a) S3 同时做「桌面登录时写下真人凭证」；(b) 先放行无 agent 祖先的进程，继续用 daemon 的 agent 账号（和今天一样），真人凭证以后再说。推荐 (b)，P2.5 的重点是管住 agent。
5. **批准人资格怎么判断？** 审批卡片的裁决经 MQTT RPC 到 daemon，带的是 peer / actor。要判断「真人且对 app 有 admin」，daemon 需要问平台。推荐：daemon 把裁决人的 user id 交给 FC 的一个新内部接口（service token），由 `caller_app_access` 的同款逻辑判断；聊天 `/allow` 按渠道账号映射到用户，映射不到就不算。
6. **非 pi 的 agent**：只有 pi host 会注册进 `HostProcessRegistry`，其他 runtime 发起的命令会被当成真人。ADR-0014 之后只有 pi，所以接受；但要写进 `whoami` 的判断依据，并加测试。

## 5. 验证

- 每步：daemon / crate 单元测试 + CLI 契约测试（输出外层、退出码、截断、密钥不回显）。
- S3：真机验证 agent bash 写操作走 socket 被认成 agent，终端被认成真人，TCP 写请求 403（unix）。
- S4：桌面、iOS、聊天 `/allow` 各批一次；拒绝、超时、批准后漂移各一次；full-access 会话和 cron 会话各一次。
- S6 前：self-host 上用只装 amuxd 的 agent 跑完退出标准 2，以及 app E2E 35 项（改用 CLI 版）。
