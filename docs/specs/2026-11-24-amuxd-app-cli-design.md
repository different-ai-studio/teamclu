# `amuxd app` 命令树

- **Date**: 2026-11-24
- **Status**: Draft（2026-11-24 grilling 已过 Q1–Q23，决策见 §7）
- **Parent**: `2026-11-24-app-platform-infra-decoupling-design.md` §7（CLI 规范 C1–C10、审批 §7.5、退役清单 §7.6）
- **覆盖范围**：现有 `amuxd app` 9 条子命令（`apps/daemon/src/cli/app.rs`）+ 桌面 `manage_app*` 7 个工具的全部 action
  （`apps/desktop/crates/teamclu-introspect/src/apps.rs`、`apps/files.rs`）。对照表见 §6，一条不落。

## 1. 设计原则

- **主要用户是 agent**，人是次要用户（Q1）。默认输出恒为 JSON，`--help` 短，错误带 `next`。
- **名词在前、动词在后**：`amuxd app <组> <动词>`；app 自身的生命周期动词直接挂在 `app` 下。
- **两种「谁能进」分开命名**（Q2）：`access` = 谁能**管理**这个 app（read/write/admin）；`gate` = 谁能**访问**上线后的网站（登录墙）。
- **平台 vs TeamClu 层**（Q3）：标 🅣 的命令属于 TeamClu 层（本机 checkout、会话），不打平台接口，但留在同一棵树里。
  平台以后拆成独立 `appctl` 时它们不跟着走。
- 权限名统一 read / write / admin（20261117 迁移已改，桌面工具描述里还是旧名 view/prompt）。

## 2. 全局约定

### 2.1 选 app（Q14）

| 写法 | 含义 |
|---|---|
| （不写） | 当前目录所在 checkout 对应的 app；读写操作都可以 |
| `--app <name\|slug>` | 必须唯一匹配；有歧义 → 退出码 5，返回候选，不猜 |
| `--id <uuid>` | 精确指定 |

标 ⛔ 的命令（不可逆：`undeploy`、`delete`、`files purge`）**不接受 cwd 默认**。每条写操作的输出都带实际作用的 app 名和 id。

### 2.2 输出（Q1 / Q8 / Q13）

- 默认恒为 JSON；`-o table` 给人看；`-o file:<path>` 把完整结果写到文件、stdout 只回摘要。
- 外层带版本号，字段只增不删，删字段或改语义升 v2：
  - 成功：`{"v": 1, "ok": true, "data": …}`
  - 失败：`{"v": 1, "ok": false, "error": {"code": "…", "message": "…", "next": "amuxd app …", "retryable": false}}`
- **输出上限**：

  | 命令 | 默认 | 单字段截断 |
  |---|---|---|
  | `logs` | 50 条 | 消息 2KB |
  | `data rows` | 20 行 | 单元格 1KB |
  | `files ls` | 100 条 | — |
  | 任意命令 | 总输出 64KB | 超出截断，带 `truncated: true` + `next_cursor` |

### 2.3 退出码（契约的一部分）

| 码 | 含义 | agent 该做什么 |
|---|---|---|
| 0 | 成功（`--detach` 受理也是 0，看 `state`） | — |
| 2 | 参数错误（含旧参数名，`next` 给新写法） | 改参数 |
| 3 | 没有身份 / 未登录（真人无凭证时的写操作） | 停下，告诉用户 |
| 4 | 权限不足 | 停下，告诉用户需要谁授权什么级别 |
| 5 | 找不到 / 有歧义 | 从候选里选，或问用户 |
| 6 | 冲突：部署锁、漂移（含批准后重新预检发现的漂移）、checkout 不干净、配额满 | 按 `next` 处理 |
| 7 | 平台或云厂商错误 | 看 `retryable` |
| 8 | **结果未知** | **禁止自动重试**，用 `op status` 查 |
| 9 | 审批被拒或超时 | 什么都没发生；告诉用户，不重试 |

### 2.4 复杂输入与密钥（C4 / C5）

- 结构化输入一律 `--file <path>`，或 `--file -` 从 stdin 读 JSON。
- 密钥**只能**从 stdin 或文件读：`--secret` 与 `--value` 同时出现直接退出码 2；输出永不回显密钥。

### 2.5 身份（Q9 / Q19）

- 由进程祖先决定：调用方链上有 agent host → agent 账号；否则 → 真人凭证（桌面端登录时写下）。
- 真人没有凭证时只能跑只读命令。`amuxd app whoami` 说明当前身份和判断依据。
- unix 上写操作只走 unix socket；TCP + root token 的写请求 403。

### 2.6 长操作与审批（Q17 / Q18 / Q21）

> **2026-11-26 作废：不做审批。** 有权限就执行，没权限就拒绝。见 `2026-11-26-app-platform-p25-cli-takeover.md`。
> 长操作（amuxd 执行、CLI 等待、`op wait`、`--detach`）保留（该文档 §4 Q2）；⚠ 标记和退出码 9 不再使用。

- 真正干活的是 amuxd，CLI 只是等待者：`deploy` / `undeploy` 默认等到**审批 + 执行**都结束；进度写 stderr，结果 JSON 写 stdout。
- CLI 被杀（模型自设 bash 超时、用户中断）不影响操作，`amuxd app op wait <op>` 接着等。
- `--detach` 立刻返回 `{"op": "…", "state": "pending_approval" | "running"}`。
- 标 ⚠ 的命令由 agent 发起时，amuxd 在该会话里发起审批（定位不到会话 → 主人收件箱）；会话内 10 分钟、收件箱 24 小时超时 → 退出码 9。
  批准人须是对该 app 有 admin 的真人。full-access 不放行，没有「总是允许」，cron / 渠道会话不豁免。细节见父 spec §7.5。
- 真人在终端里直接用不拦。

## 3. 命令树

```
amuxd app
├── whoami                                 当前以谁的身份操作、依据是什么
├── list [--mine]                          可见的 app，含本机 checkout 路径
├── status                                 全部设置 + checkout + 声明 + 领先线上几个提交 + 进行中的操作
├── create <name> [--type T]               新建 app 并把代码放到本机
│        [--from-git URL | --from-dir DIR] [--no-checkout]
├── update [--name N] [--type T]
├── runtime [--language node|python|go|php|java]
│                                          部署契约、地域能力、历史观测、本机构建条件
├── deploy [--migration] [--move-domain] [--detach]                    ⚠
├── undeploy [--detach]                                              ⚠ ⛔
├── delete --yes                                                     ⚠ ⛔
├── logs [--since 30m | --since-cursor C] [--limit 50]
│        [--kind app|request|all] [--grep TEXT] [--request-id ID]
│
├── op                                     长操作与审批
│   ├── status <op>                        快照，不碰 daemon / git
│   ├── wait <op>                          等到终态；按 §2.3 返回退出码
│   └── list [--active]
│
├── access                                 谁能管理这个 app
│   ├── ls                                 直接授权 / org 授权 / 委托来的权限（标来源）；
│   │                                      可授权对象分真人和 agent 两栏，agent 标主人
│   ├── grant <who> <read|write|admin>                                 ⚠
│   ├── grant --org <read|write>           授权给整个 org（取代 visibility=team）⚠
│   ├── revoke <who>                                                   ⚠
│   └── revoke --org                                                   ⚠
│
├── gate                                   谁能访问上线后的网站（登录墙）
│   ├── show                               规则、生效策略、组织角色目录
│   ├── set [--mode none|platform] [--audience any|org] [--scope all|paths]
│   │                                      只改传了的字段                  ⚠ 改成 none 时
│   ├── set --rules-file F                 整体替换规则列表
│   ├── rule add <path> --auth required|public [--audience any|org] [--roles R,…]
│   └── rule rm <path>
│
├── env                                    环境变量与密钥（下次 deploy 生效）
│   ├── ls                                 密钥永不回显值
│   ├── set <KEY> --value V                普通变量
│   ├── set <KEY> --secret [--file F]      密钥，值只从 stdin / 文件读
│   └── rm <KEY>
│
├── data                                   线上数据库（data_app，已部署）；一次只动一行（Q6）
│   ├── tables
│   ├── rows <table> [--where COL OP VAL] [--limit 20] [--cursor C] [--desc]
│   ├── insert <table> --file F|-
│   ├── update <table> --key COL=VAL… --file F|-
│   └── rm <table> --key COL=VAL…
│
├── files                                  对象存储里的附件
│   ├── ls [PREFIX] [-r] [--cursor C] [--limit 100]
│   ├── get <path> [-o LOCAL]              不给 -o 返回临时链接
│   ├── put <LOCAL> [path] [--content-type T]
│   ├── rm <path>
│   ├── rm -r <PREFIX>                     不能是根
│   ├── purge --yes                                                  ⚠ ⛔
│   ├── usage [--refresh]
│   └── quota <BYTES|default>
│
├── cron                                   平台定时调用 app 自己的 URL
│   ├── ls
│   ├── add --name N --schedule "M H D M W" [--tz Asia/Shanghai]
│   │       [--method GET] [--path /] [--file request.json]
│   ├── edit <job> [同 add 的参数]
│   ├── enable <job> | disable <job>
│   ├── run <job>                          立刻跑一次，不改计划
│   ├── runs <job> [--limit 20]
│   └── rm <job>
│
├── domain                                 自定义域名（仅 self-host）
│   ├── show
│   ├── set <host>                         返回要配的 CNAME + TXT          ⚠
│   ├── verify
│   └── rm                                                             ⚠
│
├── checkout 🅣                             本机代码目录
│   ├── where
│   ├── clone [DIR]                        把别人的 app 拉到本机
│   ├── move <DIR>
│   ├── bind <DIR>                         把已有目录认作该 app 的 checkout
│   └── reseed                             代码从未写成功时重写
│
└── sessions 🅣                             关联的会话
```

`<who>`：org 内任意真人或 agent 账号（包括别人的 agent），用户 id 或唯一匹配的名字；有歧义 → 退出码 5（Q16）。
`<job>`：job id，或唯一匹配的名字。

## 4. 典型流程（给 skill 用）

```bash
# 部署：默认一直等到审批和部署都结束
amuxd app status
amuxd app runtime --language node        # 选运行时，不要凭记忆猜
amuxd app deploy                         # 0 成功 / 9 被拒或超时 / 6 漂移 / 8 未知（不要重试）
# 如果命令被中断：
amuxd app op list --active
amuxd app op wait <op>

# 设密钥（值不出现在命令行）
printf %s "$TOKEN" | amuxd app env set STRIPE_KEY --secret
amuxd app deploy

# 登录墙：增删单条规则，不用整体读出再写回
amuxd app gate rule add /admin --auth required --audience org
amuxd app gate rule rm /legacy

# 部署后看新日志
amuxd app logs --since 5m                # 返回 next_cursor
amuxd app logs --since-cursor <cursor>   # 只拉之后的
```

## 5. `--help` 写法（C1）

每条子命令的 `--help` 不超过 15 行：一句话说明 + 需要的权限 + 是否要审批 + 1–2 个例子。
顶层 `amuxd app --help` 只列组和一行说明，不展开参数。系统提示词里只放一行：

> 应用的创建、部署和管理用 `amuxd app`（先看 `amuxd app --help`）；流程见 `deploy-app` skill。

## 6. 与现状的对照

| 现在 | 新命令 | 备注 |
|---|---|---|
| `manage_app list` / CLI `list` | `list` | |
| `manage_app status` / CLI `status` | `status` | |
| `manage_app deploy_status` | `op status <op>` | `status` 也带进行中的操作 |
| `manage_app auth_info` | `gate show` | |
| `manage_app runtime_info` | `runtime` | CLI 新增 |
| `manage_app sessions` | `sessions` 🅣 | CLI 新增 |
| `manage_app create` / CLI `create` | `create` | `--git-remote`/`--dir` → `--from-git`/`--from-dir`；新增 `--no-checkout`；去掉 `--visibility` |
| `manage_app update`（name / type） | `update` | |
| `manage_app update`（visibility） / CLI `update --visibility` | `access grant --org read` / `access revoke --org` | visibility 取消（Q11） |
| `manage_app update`（auth_*） / CLI `update --auth-*` | `gate set` / `gate rule add\|rm` | 从 `update` 拆出 |
| `manage_app reseed` / CLI `reseed` | `checkout reseed` 🅣 | |
| `manage_app download` / CLI `download` | `checkout clone` 🅣 | |
| `manage_app move_workdir` | `checkout move` 🅣 | CLI 新增；daemon 已有 `/v1/apps/:id/move-workdir` |
| （daemon `/v1/apps/:id/bind-workdir`，无工具） | `checkout bind` 🅣 | 新暴露 |
| `manage_app deploy` / CLI `deploy` | `deploy` | 会话审批代替原生弹窗；默认同步等待，`--detach` 可选 |
| `manage_app undeploy` / CLI `undeploy` | `undeploy` | 同上 |
| `manage_app logs` / CLI `logs` | `logs` | `--minutes` → `--since 30m`；新增 `--since-cursor` |
| `manage_app delete` / CLI `delete` | `delete --yes` | |
| `manage_app_access` list / grant / revoke | `access ls / grant / revoke` | view/prompt → read/write；新增 `--org` |
| `manage_app_data` tables / rows / insert_row / update_row / delete_row | `data tables / rows / insert / update / rm` | 仍然一次只动一行 |
| `manage_app_files` list / download / upload / delete / delete_folder / purge / usage / set_quota | `files ls / get / put / rm / rm -r / purge / usage / quota` | `purge` 新增审批 |
| `manage_app_env` list / set / delete | `env ls / set / rm` | 密钥只走 stdin |
| `manage_app_cron` list / create / update / delete / run / runs | `cron ls / add / edit / rm / run / runs` + `enable` / `disable` | enabled 从 update 参数提成动词 |
| `manage_app_domain` get / set / verify / remove | `domain show / set / verify / rm` | |
| — | `whoami` | 新增 |

**不兼容变更**（Q7，直接改、不留别名，旧参数报退出码 2 并在 `next` 给新写法）：
`update --auth-*` → `gate`；`create/update --visibility` → `access --org`；`create --git-remote/--dir` 改名；`logs --minutes` → `--since`；
`/v1/app-ops` 写操作不再接受 TCP + root token（unix）；终端里真人操作改用真人身份。

## 7. 已定决策（2026-11-24 grilling）

> 2026-11-26：Q5、Q18、Q20–Q23（审批）作废，Q17 的审批部分作废、长操作保留，Q19（区分 agent 与真人）不再需要，Q10 作废（Delegation 最高到部署，按 P2）。

| # | 决策 |
|---|---|
| Q1 | 主要用户是 agent；默认恒为 JSON，`-o table` 给人看 |
| Q2 | `access`（管理权限）与 `gate`（网站登录墙）分组；登录墙参数从 `update` 移出 |
| Q3 | `checkout` / `sessions`（TeamClu 层）留在同一棵树，🅣 标注 |
| Q4 | `create` 保持组合（建记录 + 放代码），加 `--no-checkout` |
| Q5 | 审批：deploy、undeploy、delete、access grant/revoke、domain set/rm、gate 改公开、`files purge`；data 写和 env set 不审批 |
| Q6 | `data` 一次一行，不提供 SQL；批量走 `migrations/*.sql` |
| Q7 | 不兼容变更直接改，不留别名 |
| Q8 | JSON 外层 `"v": 1`，字段只增不删；退出码表属契约 |
| Q9 | 终端里真人以真人身份操作；无凭证只读；新增 `whoami` |
| Q10 | agent 继承主人权限用 Delegation，封顶 write → agent 不能部署主人的 app（与 11/20 不同，已接受） |
| Q11 | 取消 `visibility`，改 `access grant --org`；现有 team 可见迁成 org read |
| Q12 | `gate set` 部分更新，`--rules-file` 整体替换，加 `gate rule add/rm` |
| Q13 | 每条命令输出有上限，超出截断并给游标 |
| Q14 | 写操作也可按 cwd 默认选 app；⛔ 除外；输出带实际作用的 app |
| Q15 | 不做 `logs --follow`，加 `--since-cursor` |
| Q16 | 可授权给 org 内任意真人或 agent，无需 agent 主人同意 |
| Q17 | `deploy`/`undeploy` 默认同步等待；amuxd 执行、CLI 只等待；`--detach` 可选 |
| Q18 | pi 扩展注入 `TEAMCLU_SESSION_ID`，amuxd 核对后在会话里审批；不行就发主人收件箱；full-access 不放行 |
| Q19 | unix 上写操作只走 unix socket + 进程祖先，TCP + root token 写 403；Windows 用 TCP bearer + 代次 |
| Q20 | 批准人须是对该 app 有 admin 的真人；agent 不能批 |
| Q21 | 会话内 10 分钟、收件箱 24 小时超时；批准后执行前重新预检 |
| Q22 | 第一期不提供「总是允许」 |
| Q23 | cron / 渠道会话也要审批，agent 自建的 app 不豁免；无人值守自动部署第一期不支持（已接受） |
