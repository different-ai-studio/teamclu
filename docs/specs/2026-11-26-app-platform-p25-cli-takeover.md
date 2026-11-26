# App 平台 P2.5：`amuxd app` CLI 接管，`manage_app*` MCP 退役（实施计划，草案）

- 父 spec：`2026-11-24-app-platform-infra-decoupling-design.md` §7（CLI 规范 C1–C10、审批 §7.5、退役清单 §7.6）。
- 命令树：`2026-11-24-amuxd-app-cli-design.md`（Q1–Q23 已拍板）。
- 平台侧依赖：P2（PR #2016，Delegation、`caller_app_access`）、P3（`app_links` / `app_grants` / `app_forge_repos`）。
- **状态：2026-11-26 已拍板（§4），开始实施。**
- **2026-11-26 决定：不做审批。** 有权限就执行，没权限就拒绝，由平台的权限判断（`caller_app_access`）决定。
  父 spec §7.5 和 CLI 设计 §2.6 / Q5、Q17–Q23 里的审批部分作废。

## 0. 目标与退出标准

**目标**：agent 只用 `amuxd app` 管理应用；桌面 `manage_app*` 7 个工具、`introspect_api/apps*` 和 app 相关的确认弹窗删除。能不能做一件事只看平台权限，不再有审批。

**退出标准**（父 spec §8 P2.5）：
1. 新会话的系统提示词里没有 `manage_app*`，只有一行指向 `amuxd app --help`。
2. 只装 amuxd（不开桌面）的 agent 能走完：建 app → 部署 → 改 env → 看日志。
3. 没有权限的操作返回退出码 4 和「需要谁授予什么级别」；有权限的操作直接执行，包括 cron 和渠道会话里的无人值守部署。
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
- 身份：CLI 的所有调用都以 daemon 自己的 agent 账号去问平台，平台按这个账号的授权（含 Delegation）判断。不再审批之后，这就是最终的模型，不需要区分「agent 还是真人在调用」。

## 2. 步骤

每步单独合并。S1、S2 完成之前 MCP 不动。

| 步 | 内容 | 依赖 | 规模 |
|---|---|---|---|
| **S1 CLI 契约底座** | `{"v":1,"ok",…}` 外层、错误 `code/message/next/retryable`、退出码表（0、2–8，9 不再使用）、输出上限和截断游标、`-o table`、`-o file:`、`whoami`（说明当前是哪个账号、在哪个团队）、`--help` 规范；现有 9 条命令按 Q7 改参数（`--visibility` → `access --org`、`--auth-*` → `gate`、`--git-remote/--dir` → `--from-git/--from-dir`、`--since`）；CLI 契约测试 | — | 中 |
| **S2 补齐命令** | `teamclu-apps` 增加 access / gate / env / data / files / cron / domain / runtime / sessions / `checkout move\|bind`，挂到 `/v1/app-ops` 和 CLI。桌面 `settings.rs` / `data.rs` / `files.rs` 的逻辑搬进 crate。可拆成 S2a（只读 + env / cron / data / domain）、S2b（files，CLI 进程里直接传字节）、S2c（access / gate） | S1 | 大 |
| **S3 长操作** | deploy / undeploy 由 amuxd 在后台执行，CLI 只等待；CLI 被杀不影响操作，`op status / wait / list`、`--detach`、退出码 8 表示「结果未知、不要重试」 | S1 | 中 |
| **S4 切换文案** | 系统提示词一行；`deploy-app` / `app-auth` skill、`app-deploy-prompt.ts`、locale、`app_build.rs` / `app-runtime-spec.ts` 里的错误文案改成 `amuxd app`；`teamclu-apps` 的 `Surface` 统一为 CLI；更新钉住文案的测试 | S2 | 小 |
| **S5 删除** | 删 `teamclu-introspect` 的 `manage_app*`、桌面 `introspect_api/apps*`、app 相关确认弹窗（`confirm.rs` 里 app 的部分和 `confirm/app_domain*`，保留 `mcp_servers_replace`）、`caller.rs` 里 app 路由的条目 | S4 | 中（主要是删） |

不可逆操作的防手滑规则保留，它们不是审批：`undeploy`、`delete`、`files purge` 必须显式指定 app（不按当前目录推断），`delete` / `purge` 要带 `--yes`。

## 3. 设计稿写完之后变了的前提

- **Delegation 的上限**：CLI 设计 Q10 写的是「Delegation 封顶 write → agent 不能部署主人的 app」。P2 实际落地的是 P2 Q1「委托权限最高到部署，不能管理授权、不能删 app」：`caller_app_access` 给主人 app 的委托级别可以到 admin，FC 用 `assertNotInheritedFor` 挡住 delete 和授权管理。两者不一致，见 §4 Q1。
- **visibility**：CLI 设计 Q11 取消 `visibility`，改用 `access grant --org`。P3 Q1 保留了 `/v1` 的 `visibility` 字段（由 org 授权推导）。CLI 的 `access grant --org read` 可以落到 PATCH visibility=team，`revoke --org` 落到 personal；`--org write` 平台允许（`app_grants_org_level`），但现在没有接口。
- **身份**：`manage_app` 用登录真人的 bearer，CLI 用 agent 自己的账号。切换后 agent 看到的 app 少了：主人的个人 app 只能通过 Delegation 看到。agent 建的 app 归 agent；Delegation 是「agent 按主人的级别行事」，反过来主人看不到 agent 的 app，除非 agent 授权给他。

## 4. 决定（2026-11-26）

| # | 问题 | 决定 |
|---|---|---|
| Q1 | agent 对主人的 app 能做到哪一步 | 保持 P2 现状：Delegation 按主人的级别，最高到部署，不能删 app、不能管理授权。主人是 admin 的 app，他的 agent 可以直接部署。CLI 设计 Q10 作废 |
| Q2 | 长操作（S3）做不做 | 做：deploy / undeploy 由 amuxd 后台执行，CLI 只等待，`op status / wait / list`、`--detach`、退出码 8 |

## 5. 验证

- 每步：daemon / crate 单元测试 + CLI 契约测试（输出外层、退出码、截断、密钥不回显）。
- 权限：agent 对自己建的 app、主人的 app（经 Delegation）、别人授权给它的 app、无关的 app 各跑一遍 deploy / env set / access grant / delete，结果和平台权限一致；没权限时退出码 4。
- S3：deploy 途中杀掉 CLI，`op wait` 能等到结果。
- S5 前：self-host 上用只装 amuxd 的 agent 跑完退出标准 2，以及 app E2E 35 项（改用 CLI 版）。
