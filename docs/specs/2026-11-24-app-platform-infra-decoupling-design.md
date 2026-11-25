# App 平台基建化 — 与 TeamClu 产品层解耦

- **Date**: 2026-11-24
- **Status**: Draft（定位已拍板，见 §0；§9 待定）
- **Builds on**: `2026-11-16-app-platform-identity-design.md`（身份共享）、`2026-09-23-app-deploy-intent-contract-design.md`（部署契约）
- **一句话**: 把 apps 模块从「TeamClu 的一个功能」变成「给 agent 用的内部云平台」：
  阿里云资源包一层，agent 通过 amuxd 一条命令拿到带数据库、存储、域名、登录墙的可运行环境。
  TeamClu 变成这个平台的**一个客户**，而不是平台的宿主。
- **Non-goals**: 对外开放 / 独立账号体系 / 计费；AWS；代码托管（Gitea）；拆成独立部署的服务（留到 §8 P4 再评估）。

## 0. 已拍板的决策

| # | 问题 | 决定 |
|---|---|---|
| 1 | 定位 | **内部基建**。只服务我们自己的 agent 和人；客户端前提是**至少装了 amuxd**（桌面端可选） |
| 2 | 云厂商 | **只做阿里云**（FC / OSS / SLS / STS / 镜像仓库）+ 自建 Postgres、S3 兼容存储、Caddy/Traefik。AWS 暂不考虑 |
| 3 | 代码托管 | **Gitea 不属于平台**。平台只收构建产物（zip / 镜像）和一个不透明的 revision 字符串；仓库、HEAD 校验、deploy key、协作者同步都留在 TeamClu 层 |
| 4 | 身份 | 沿用 11/16：**租户 = `public.orgs.id`，主体 = `auth.users.id`**（真人或 daemon 的 agent 账号），平台不建自己的账号表 |
| 5 | agent 接口 | **`amuxd app` CLI 是 agent 的唯一入口**；桌面 `manage_app*` MCP 退役（省约 5k token / 会话、去掉对桌面端的依赖）。代价用 CLI 规范补回，审批挪到 amuxd。见 §7 |

## 1. 现状

apps 已经是个小 PaaS（FC 侧约 1.27 万行 + `crates/teamclu-apps` 4300 行 + `amuxd app` CLI），但寄生在 TeamClu 里。

**云资源层已经解耦得不错**：`makeFcOps`（`provisioning/fc-client.ts:447`）、`makeSlsOps`（`sls-client.ts:169`）、
`makeAppStorageOps`（`app-storage.ts:296`）、`StartDeployDeps` / `FinalizeDeps`（`app-deploy.ts:261/345`）都是注入式的。
部署时**构建在 amuxd 本地完成**，云端从不 clone 代码（`apps/daemon/src/sync/app_build.rs`），FC 只签上传地址和 finalize。

**耦合集中在三处：**

1. **授权 = 团队 API。** 所有 `/v1/apps` 按 `teamId` 取（`supabase-repo.ts:5002`），权限从 actor 解析
   （`resolveCurrentActor` :5097 / :6418），RLS 依赖 `amux.is_team_member` / `actor_has_app_access`。
   `amux.apps` 外键指向 `amux.teams`（CASCADE）、`amux.actors`、`amux.workspaces`；
   `app_env_vars` / `app_cron_jobs` 的操作人外键指向 `amux.members`；`createApp` 顺手插一行 `amux.workspaces`（:5190）；
   `amux.sessions.app_id` 反向挂在 app 上。
2. **登录墙身份。** `apps-login-service.ts`、`apps-tenant-identity.ts`、`apps-org-role-identity.ts`、`app-role-bindings.ts`
   读 `public.users` / `roles_users` / `admin_type` —— 这些是 **org 级**身份，和决策 4 一致，可以保留；
   只有登录页里的 `teams.name`（`apps-login-service.ts:151`）是 team 级的，要去掉。
3. **Gitea 贯穿创建/部署/授权。** `createApp` 建仓库（:5254-5300）、部署时服务端复核 Gitea HEAD（:5781）、
   `git-credential` deploy key、`gitea-sync` 把 TeamClu 授权镜像成协作者、`routes/git.ts`、
   权限名 read/write/admin 刻意对齐 Gitea。
   但**导入 / 本地 app 那条路径已经完全不经过 Gitea**：revision 是工作目录的 `sha256:` 内容摘要（`apps/daemon/src/sync/app_git.rs:967`）。

另外一个事实：**self-host 的计算也在阿里云 FC 上**（`makeDeployDeps` 没有 FC endpoint 直接拒绝，`index.ts:155`），
目前没有纯本地的计算驱动。

## 2. 目标形态

```
 调用方        amuxd app CLI  ·  amuxd MCP 工具(manage_app)  ·  TeamClu 桌面/网页 UI
                      │                                   │
                      │  Bearer = auth.users JWT（真人 / agent 账号）
                      ▼                                   ▼
 ┌──────────────── App Platform（control plane）────────────────────┐
 │  Project · Deployment · Env/Secret · Cron · Domain · Storage ·   │
 │  Grant · LifecycleOp · 登录墙(Gate)                              │
 │  只认 org_id + user_id；不知道 team / actor / session / Gitea    │
 └──────┬───────────┬──────────┬──────────┬──────────┬──────────────┘
        │ Compute   │ Objects  │ Logs     │ Database │ Edge(域名/证书/路由)
        ▼           ▼          ▼          ▼          ▼
     阿里云 FC   OSS / S3    SLS     自建 PG(DDL)  Caddy / Traefik

 TeamClu 层（平台的客户）:
   app ↔ team / workspace / session 的关联、agent 继承主人权限的策略、
   Gitea 仓库与 deploy key、部署前 HEAD 校验、把「部署」按钮翻译成 agent 提示词
```

**边界规则（以后评审就按这一条判）：** 平台代码里不出现 `team`、`actor`、`member`、`session`、`workspace`、`gitea` 这些词；
TeamClu 层可以随便引用平台的 app id。

## 3. 平台领域模型

| 概念 | 对应现状 | 说明 |
|---|---|---|
| **Project**（仍叫 app） | `amux.apps` 去掉 team/actor/workspace 外键 | `org_id`（租户，也是 PG 库定位符 `tc_org_<hex>`）、`created_by_user_id`、slug / app_code、运行时声明、auth 配置、域名、存储 |
| **Deployment** | apps 上的 deploy_* 列 + `app_lifecycle_operations` | 输入只有：产物（OSS key 或镜像引用）+ `revision`（不透明字符串，git sha 或 `sha256:` 都行）+ 部署声明 |
| **Grant** | `app_member_access` + 现在的 `visibility=team` | `(app_id, principal, level)`，level = read/write/admin。principal 是一个 `auth.users`（真人或 agent 账号），或**整个 org**（只能 read/write）。不是 actor |
| **Delegation** | 现在的「agent 继承主人权限」RPC | 见 §5 |
| **Env / Secret / Cron / Domain / Storage** | 现有表 | 操作人列改成 `user_id`，不再指向 `amux.members` |
| **Gate**（登录墙） | `apps-auth-*` | 保持 org 级身份；不再读 `teams` |

权限名 read/write/admin 保留——它本来就是通用的三档，只是不再「为了对齐 Gitea」。

## 4. Provider 驱动

把现有注入点收敛成六个接口，第一期每个只有阿里云 / self-host 一个实现：

| 驱动 | 现有实现 | 接口要点 |
|---|---|---|
| `Compute` | `fc-client.ts`、`app-runtime-*` | ensureService(decl, artifact, env) → endpoint；scale；delete；status |
| `ObjectStore` | `apps-oss.ts`、`app-storage.ts` | presignPut；scopedCredentials(prefix)；usage；deletePrefix |
| `Registry` | `apps-registry.ts` | pushHandle(appId, revision)；imageBelongsTo |
| `Logs` | `sls-client.ts`、`app-logs.ts` | ensureSink(appId)；query(window) |
| `Database` | `app-postgres.ts`、`app-data-db.ts` | ensureSchema(org, app)；connectionString；runMigrations；browse |
| `Edge` | `apps-vanity/custom-domain/traefik-provider`、Caddy ask | resolveHost；verifyDomain；routes |

不做 AWS，**接口仍然要抽**：一是边界规则的落点，二是能用假驱动做平台的契约测试（今天测部署要真 FC）。

**P0 实际落地（2026-11-24）**：只有 `Compute`、`ObjectStore`、`Logs` 三个背后是阿里云 SDK，抽成了驱动
（`services/fc/src/lib/app-platform/provider.ts`，阿里云实现 `aliyun.ts`）。`Registry` 是通用 Docker registry、只有配置；
`Database` 是 Postgres 连接串；`Edge` 是 Caddy / Traefik + DNS——三者本来就不绑厂商，P0 不动。
接口形状照搬原来 deploy / teardown / storage / logs 对阿里云封装的用法，先划线、不重新设计。
是否加一个本地 Docker 的 `Compute` 实现给纯 self-host 用，见 §9。

## 5. 身份与授权

- 调用方都带 `auth.users` 的 JWT：真人来自桌面端登录写下的真人凭证（与 11/16 git token 同一条路，`~/.{brand}/git-credential.json` 那类文件）；agent 用 daemon 的 agent 账号（已有，`DaemonCloud`，`apps/daemon/src/http/app_ops.rs:45`）。
- **amuxd 用谁的身份，由进程祖先决定，不由 token 决定**（2026-11-24 grilling Q9 / Q19）：
  - 调用方进程链上有 agent host → 用 agent 账号；没有 → 用真人凭证。
  - 没有真人凭证（只装了 amuxd、没装桌面端）时，真人只能跑只读命令，写操作退出码 3（「请登录」）。纯 CLI 登录仍是远期。
  - 现状 `/v1/app-ops` 不论谁调都用 agent 账号，终端里真人的操作会被记到 agent 名下——P2.5 改掉。
- 平台鉴权：`org 成员` + `Grant` + 创建者 = admin。**不再按 team 过滤**，列表接口改成按 org（可选按 TeamClu 传来的 app id 集合过滤）。
- **团队可见 → 授权给整个 org**（Q11）：去掉 `visibility personal|team`，改成 Grant 的 principal 可以是 org（只能 read / write）。
  现有 `team` 可见的 app 一次性迁成 org read 授权；新建默认只有创建者可见。代价：一个 org 下可能有多个团队，org 可见比团队可见范围大，内部基建可以接受。
- **授权对象**（Q16）：org 内任意真人或 agent 账号（包括别人的 agent），不需要该 agent 主人同意。
- **agent 继承主人权限 → 通用的 `Delegation`**（Q10）：`(delegate_user_id → principal_user_id)`，含义是「代理人拿到委托人的级别，**封顶 write**，不能管授权、不能删 app」。
  TeamClu 在 agent 账号创建 / 停用 / 换主人时写这张表。平台只认「委托」，不认「agent」。不把每个 grant 物化复制到 agent 身上，也就不会漂移。
  **与 11/20 决策 6 的差异（已确认接受）**：11/20 规定主人是创建者时 agent 拿 admin；封顶 write 后 **agent 不能部署主人的 app**（部署需要 admin），要部署须由主人另行授权 admin。
  **2026-11-25 修订（P2 方案 Q1）：不封顶到 write。** 代理人拿到委托人的级别，最高可以部署（保住「成员建 app、agent 部署」这条主流程），
  但永远不能管授权、不能删 app。
- 原生审批弹窗（部署 / 删除 / 改授权，`introspect_api/confirm.rs`）是桌面端的能力。只装 amuxd 时改由 amuxd 发起审批，见 §7.5。

## 6. Gitea 移出平台

部署契约统一成现在「导入 app」那条路：**客户端构建 → 上传产物 → finalize(revision)**。平台不校验 revision 的含义。

| 现在在平台里 | 去哪 |
|---|---|
| `createApp` 里建 Gitea 仓库 | TeamClu 层：建完 app 后由 TeamClu 的 forge 集成建仓库，关联存在 TeamClu 侧 |
| 部署时服务端复核 Gitea HEAD（`supabase-repo.ts:5781`） | 挪进 forge 的 `deployGuard`（平台只对托管仓库的 app 调用它），客户端部署前检查（`crates/teamclu-apps/src/deploy.rs:301`）照旧保留。原计划是平台端直接删掉，P1 实施时改为保留在 forge 里，理由见 P1 方案 §2.2 |
| `git-credential` deploy key、`deploy-key-expiry` | TeamClu forge 集成 |
| `gitea-sync`、`routes/git.ts`、`supabase-repo/app-git-access.ts` | TeamClu forge 集成；它读平台的 Grant 来决定协作者 |
| `apps.git_remote_url` / `git_auth_kind` / `git_commit_sha` | 前两个搬到 TeamClu 侧；`git_commit_sha` 并入通用的 `revision` |

#1888 做的按账号鉴权不受影响，只是代码从「平台」搬到「TeamClu forge 集成」这一层。

## 7. Agent 接口：`amuxd app` CLI，退役 `manage_app*` MCP

### 7.1 现状：三个入口、三种身份

| 入口 | 路径 | 身份 | 高危确认 |
|---|---|---|---|
| 桌面 / 网页 UI | 直连 Cloud API（CRUD、授权、env、cron、日志）；「部署」按钮只是给 agent 发提示词（`packages/app/src/lib/apps/app-deploy-prompt.ts`） | 真人 | 无（真人亲手点） |
| agent → `manage_app*`（7 个工具） | `teamclu-introspect` sidecar → 桌面 13144 → 本机 daemon 构建 | **登录真人的 bearer**（`apps/desktop/src/commands/introspect_api/apps.rs:17`） | 桌面原生弹窗 |
| agent / 人 → `amuxd app` | `POST /v1/app-ops`（`apps/daemon/src/http/app_ops.rs`） | **daemon 自己的 agent 账号** | 无 |

后两者共用 `teamclu-apps` crate，但它只覆盖 list / status / create / update / deploy / logs / delete；
access / data / files / env / cron / domain 只在桌面端（`introspect_api/apps/*.rs` 约 1400 行）。

### 7.2 为什么退役 MCP

- **上下文成本**：7 个工具定义（`apps/desktop/crates/teamclu-introspect/src/apps.rs:463-671`）约 19KB ≈ **5k token**，
  每个会话都背着，和 app 无关的会话也一样；约占 11/4 实测新会话提示词（3.35 万）的 15%。
  它还是「MCP 工具顺序不固定 → 打掉提示词缓存」那条冷启动问题的一部分。
- **和 skill 重复**：`deploy-app`、`app-auth` skill 本来就按需加载并写了完整流程，工具描述又写一遍。
- **依赖桌面端**：违背决策 1「至少装 amuxd 即可」。
- **只服务 pi**：CLI 任何会跑 bash 的 agent（pi、Claude Code、Cursor）都能用，人在终端里也用同一个工具。

### 7.3 退役后的分工

- **agent**：只用 `amuxd app …`（bash 里调 CLI；如确有需要，amuxd 可另出一个极薄的同名 MCP，背后同样是 `/v1/app-ops`）。
- **UI 的纯控制面操作**：继续拿真人 token 直连平台 API，不经过 amuxd。
- **UI 需要本机的操作**（checkout / 构建 / 部署）：调 amuxd HTTP（`/v1/app-ops`，携带真人身份），**不 spawn CLI 进程**。
  CLI 和桌面都是 amuxd HTTP API 的薄客户端。
- **身份语义变化（用户能感知）**：agent 从「冒用真人身份」变成「以自己的身份」——agent 建的 app 归 agent（与 11/16 决策 10 一致）；
  agent 改真人的 app 依赖 Grant 或 §5 的 Delegation。**Delegation 是退役的前置条件**，否则会出现「我的 agent 改不了我的 app」。

### 7.4 面向 agent 的 CLI 规范（平台的正式接口约定）

CLI 不进系统提示词，换来的代价要在 CLI 本身补回来。每条子命令都必须满足（完整命令树见 `2026-11-24-amuxd-app-cli-design.md`）：

| # | 规则 | 补的是 MCP 的什么 |
|---|---|---|
| C1 | **发现**：系统提示词只留一行（「应用部署与管理用 `amuxd app`，先看 `--help`」）；流程知识放 skill 按需加载。`--help` 短、每条子命令带 1–2 个例子 | 工具常驻可见 |
| C2 | **结构化输出**：默认恒为 JSON（`-o table` 给人看），外层带 `"v": 1`，字段只增不删；退出码表同属契约（命令树文档 §2.3） | MCP 的 JSON 返回 |
| C3 | **错误可行动**：错误体带稳定 `code` + 人话 `message` + `next`（下一步该跑的命令） | 工具描述里的「失败后怎么办」 |
| C4 | **复杂参数走文件或 stdin**：SQL、登录规则、部署声明、批量 env 用 `--file <path>` 或 `-`（stdin JSON）；命令行参数只放简单标量 | JSON schema 的类型约束、免转义 |
| C5 | **密钥绝不上命令行**：`env set` / secret 类命令只从 stdin 或文件读值，参数里带值直接拒绝；输出里永远不回显密钥 | 避免进 shell 历史、进程列表、会话记录 |
| C6 | **长操作由 amuxd 执行，CLI 只是等待者**：`deploy` / `undeploy` 默认等到审批和执行都结束；CLI 被杀不影响操作，`op wait <op>` 接着等；`--detach` 立刻返回 op id。结果未知时明确返回「未知」，禁止自动重试。（pi bash 默认无超时，`bash.js:30`；模型可以自设） | 中途被杀 / 模型自设超时 |
| C10 | **输出有上限**：每条命令有默认条数和单字段截断，总输出超 64KB 截断并给 `truncated: true` + `next_cursor`；完整数据用分页或 `-o file` | 一次 `logs` 吐几百 KB 进上下文 |
| C7 | **默认目标**：不给 app 时按 cwd 所在 checkout 解析；名字有歧义返回候选、不猜；不可逆操作（delete、清空附件）必须显式指定 app | MCP 的 workspace 默认值 |
| C8 | **审批在 amuxd 做，不在 pi 做**：见 7.5 | MCP 按工具粒度的审批 |
| C9 | **文件直接给路径**：附件上传 / 下载传本地路径，不在进程间搬字节 | （CLI 更好） |

### 7.5 高危操作审批

pi 只看到一条 bash 命令，full-access（cron、渠道会话默认就是）下拦不住，所以审批必须由 amuxd 执行。
以下由 2026-11-24 grilling（Q5、Q17–Q23）定下。

**现状事实**（决定了下面的做法）：
- 审批今天只有一个来源：pi 扩展的 `tool_call` 钩子 → `extension_ui_request{confirm}`
  （`apps/daemon/assets/pi-extension/teamclu.ts:2163-2190` → `runtime/pi_rpc/events.rs:493-557`），full-access 会话自动批准（`:529-539`）。
  amuxd 没有自己发起审批的接口；但下游 `AcpPermissionRequest`（`amux.proto:144-157`）、`PermissionManager`、聊天 `/allow`（`channels/approvals.rs`）只认 `request_id`，是通用的。
- runtime-context socket 只能认出 **host**（`HostCaller`，`runtime/context_registry.rs:308`），认不出会话：一个 pi host 承载多个会话，bash 命令 detached 启动（`http/runtime_context.rs:295-299`）。
- CLI 现在靠读 `amuxd.http.token` 鉴权，agent 与人同一个系统账号，**agent 能读这个文件冒充真人**。

**认人（Q19）**
- unix 上 `/v1/app-ops` 的**写操作只接受 0600 unix socket**：读对端 pid，沿父进程链找 agent host（`runtime/proc_tree.rs:88`），有 → agent，无 → 真人。
- TCP + root token 的写请求在 unix 上一律 403（与 10/11 cloud-token 同一做法）；只读命令仍可走 TCP。
- Windows 没有对端 pid，沿用 cloud-token 的 TCP bearer + 代次方案，强度弱一些，接受。

**要审批的操作（Q5）**：deploy、undeploy、delete、access grant / revoke、domain set / rm、gate 改为公开（`--mode none`）、`files purge`。
`data` 写操作（一次一行）和 `env set` 不审批，只要求权限。

**审批发到哪（Q18）**
- pi 扩展在每次执行 bash 时注入 `TEAMCLU_SESSION_ID`（扩展知道当前会话，`teamclu.ts:500-518` 已有映射）。
- amuxd 按进程祖先认出 host，再**核对该会话确实属于这个 host**（防止填别的会话 id），然后在该会话里发起审批（`AcpPermissionRequest`，桌面卡片、手机、聊天 `/allow` 都能看到）。
- 环境变量缺失或核对不通过（脱离会话的后台进程）→ 改发 **agent 主人的个人收件箱**（桌面 + 手机推送）。
- 新增一个「非 pi 来源」的发起方和裁决方：裁决结果回到 amuxd 的待执行操作，不写回 pi 的对话框通道。
- **full-access 不自动放行平台审批**：full-access 放行的是 pi 工具调用，平台高危操作是另一道关。

**谁能批（Q20）**：必须是**真人**，且对目标 app 有 admin（改授权类还要有管理授权的资格）。agent 不能批，委托来的权限不算批准资格。
无资格的人点批准 → 返回「你没有权限批准」，审批保持待定。审批记录写明批准人。

**超时（Q21）**：会话内审批 10 分钟；转发到主人收件箱的 24 小时（期间 op 为 `pending_approval`，agent 可 `--detach`）。超时 → 退出码 9，什么都不做。
**批准后、执行前重新预检**，漂移 → 退出码 6，不用旧的预检结果直接执行。

**不提供「总是允许」（Q22）**：每次单独批。真要免审批，以后做成由 admin 显式设置的平台授权（如「此 agent 可免审批部署此 app」），而不是在审批卡片上顺手勾选。

**无人值守不豁免（Q23）**：cron / 渠道会话里没人看 → 走收件箱 24 小时；**agent 自己建的 app 也不豁免**，否则「先建 app、再部署任意代码到公网」不经任何人。
代价（已确认接受）：「agent 定时自动更新网站」第一期跑不通，必须有人点一下；以后用上面的免审批授权解决。

**真人在终端**直接用 CLI（无 agent 祖先）：不拦。

### 7.6 退役前置清单

1. 把 access / data / files / env / cron / domain 六块从桌面 introspect 搬进 `teamclu-apps`，挂到 `/v1/app-ops` 和 CLI 子命令。
2. Delegation 上线（§5，属于 P2）。
3. amuxd 侧审批（7.5），拆成：
   - a. `/v1/app-ops` 写操作改走 unix socket + 进程祖先认人，TCP + root token 写请求 403；真人凭证接入（Q9 / Q19）。
   - b. pi 扩展给 bash 注入 `TEAMCLU_SESSION_ID`；amuxd 核对会话属于 host。
   - c. 非 pi 来源的审批发起方 / 裁决方，复用 `AcpPermissionRequest` 与 `PermissionManager`；full-access 不放行。
   - d. 主人收件箱兜底（桌面 + 手机推送）、批准人资格校验、超时与批准后重新预检。
4. CLI 满足 C1–C10，并有契约测试。
5. 改写 `deploy-app` / `app-auth` skill、`apps/daemon/src/runtime/session_prompt.rs:181`、`app-deploy-prompt.ts` 和 locale 里的部署提示词，把 `manage_app` 换成 `amuxd app`。
6. 删除 `teamclu-introspect` 的 `manage_app*` 工具定义和桌面 `introspect_api/apps*`。
7. （以后）一个 daemon 承载多个 agent 账号时，CLI 按进程祖先选身份；现在一个 daemon 一个 agent 账号，不需要。

## 8. 落地步骤

每一步都能单独合并，都不改对外行为。

| 步 | 内容 | 退出标准 |
|---|---|---|
| **P0 驱动接口** ✅ 已合并（#2014，`a10e92e47`） | 在 FC 内新建 `services/fc/src/lib/app-platform/`：三个驱动接口 + 阿里云实现；`index.ts` 里的依赖组装搬到 `deps.ts`；`app-runtime-info` / `app-runtime-catalog` / `app-undeploy-config` 改走 `resolveAppPlatform()`；假驱动在 `test/fixtures/app-platform/fake.ts` | 业务代码不再直接创建 SDK client（`test/app-platform/boundary.test.ts` 守住）；部署 → finalize → 下线 → 日志用假驱动跑通（`deploy-contract.test.ts`）。阿里云封装已挪进 `app-platform/aliyun/`（`fc.ts` / `sls.ts` / `oss.ts` / `index.ts`）；`apps-oss` 里与厂商无关的文件 key 规则拆到 `provisioning/app-files.ts`，`appsRegion` 拆到 `app-platform/region.ts`；VPC 改由驱动自己读，调用方只问 `compute.joinsPrivateNetwork()`。边界测试同时禁止 `aliyun/` 外的值导入（类型导入放行）。`app-storage.ts` 已拆：接口与配额留在 `provisioning/`，STS 签名、会话策略和 `makeAppStorageOps` 进 `aliyun/storage.ts`。runtime catalog 也收进驱动：`ComputeDriver.catalogClient` 换成 `runtimes: RuntimeDiscovery`（documented / listCurrent），FC 文档快照与 ListLayers 解析在 `aliyun/runtimes.ts`，缓存和过期兜底留在 `provisioning/app-runtime-catalog.ts`。边界测试不再有例外：`@alicloud` 的 FC/SLS SDK 只出现在 `aliyun/` |
| **P1 Gitea 出平台** | §6 全部；revision 通用化；HEAD 复核挪进 forge 守卫（客户端复核保留）。实施拆分见 `2026-11-25-app-platform-p1-gitea-out.md`；P1.1–P1.4 已完成（Gitea 代码在 `services/fc/src/lib/forge/`，平台经 `app-platform/hooks.ts` 调用）；原 P1.5 搬表推迟到 P3 | 平台目录 grep 不到 `gitea`；导入 app 和 Gitea app 走同一条 finalize |
| **P2 去 team 化**（实施见 `2026-11-25-app-platform-p2-de-team.md`；收表推迟到 P3） | 新表 `amux.app_links(app_id, team_id, workspace_id)` 承接 TeamClu 关联；apps 去掉 `team_id`/`created_by_actor_id`/`workspace_id` 外键（先加 `created_by_user_id` 回填，再删）；Grant 改指 `auth.users` 或 org；`visibility=team` 迁成 org read 授权；加 Delegation（封顶 write）；RLS 改成 org + grant；操作人列改 user_id；`/v1/apps` 改按 org | 平台目录 grep 不到 `team`/`actor`/`member`/`session`/`workspace`；老客户端按 teamId 调用经 `app_links` 兼容 |
| **P2.5 CLI 接管、MCP 退役** | §7.6 清单 1、3–6（2 在 P2 内完成）；可与 P1/P2 并行做清单 1、4 | 新会话提示词里没有 `manage_app*`；agent 只装 amuxd 也能走完建 app → 部署 → 改 env → 看日志；高危操作在会话里审批 |
| **P3 独立 schema** | 平台表迁到 `app_platform` schema，FC 里只有平台模块碰它；TeamClu 只通过平台接口或 `app_links` 关联。同时完成原 P1.5：`git_remote_url` / `git_auth_kind` 进留在 `amux` 的 forge 表（`app_forge_repos`），`git_commit_sha` 并入通用的 `deployed_revision`（设计见 P1 方案 §3 P1.5） | 平台可以单独起库做测试 |
| **P4（再评估）** | 平台拆成独立服务 / 独立 CLI（`appctl`） | 有第二个调用方真的需要时再做 |

客户端同步：`crates/teamclu-apps` 改名不急，但 `Cloud` trait 的调用从 teamId 改为 org/app id（P2）；
agent 接口以 amuxd 的 `/v1/app-ops` + CLI 为准，桌面 introspect 那份在 P2.5 退役（§7）。

## 9. 待定

1. ~~Delegation 还是物化 grant~~ → 已定：Delegation，封顶 write（§5）。
2. **纯本地计算驱动？** 现在 self-host 也离不开阿里云 FC。要不要做一个 Docker/Compose 的 `Compute` 实现，让 self-host 能完全离线？建议 P0 只留接口，不做实现。
3. ~~高危操作审批的细节~~ → 已定（§7.5）。
4. ~~桌面 introspect 的 `manage_app*` 去留~~ → 已定：P2.5 退役，见 §7。剩下的问题：是否给不会跑 bash 的调用方保留一个极薄的 amuxd MCP（一个工具、透传 argv）。建议先不做，等真有这样的调用方。
5. **登录墙**是否也算平台的一部分（建议算：它只依赖 org 级身份，和决策 4 一致）。
6. **老 Gitea app 迁移**：`git_remote_url` 等列搬家改在 P3 做（2026-11-25 决定，原 P1.5），现有行一次性回填到 TeamClu 侧；回滚安全与否在 P3 设计时再定。
