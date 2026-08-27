# Apps 自助发布 — Gitea + Node FC + 可选 Platform OAuth

- **Date**: 2026-08-27
- **Status**: Approved 2026-08-27; implementation plan at `docs/plans/2026-08-27-apps-self-serve-gitea-fc.md`
- **Branch**: `docs-apps-self-serve-gitea-fc`
- **Path**: `docs/specs/2026-08-27-apps-self-serve-gitea-fc-design.md`（`docs/superpowers/` 在本仓库被 gitignore，故落在 `docs/specs/`）
- **Scope**: TeamClaw 团队用户在平台内创建、开发、发布、维护自己的 app（自助闭环）。Phase 1 交付可演示路径；目标态对齐近自助 PaaS（env / 域名 / 配额后置）。
- **Builds on**: `docs/specs/2026-06-14-apps-module-design.md`、`docs/specs/2026-06-14-apps-module-phase2-design.md`、`docs/specs/2026-07-28-app-types-design.md`
- **Non-goals (Phase 1)**: 中心 build worker、**服务端→daemon 的构建任务通道**、Gitea Actions 构建、自定义容器部署、环境变量面板、自定义域名、配额 UI、per-team Gitea org、GitForge 抽象、CodeUp fallback、`third` 真接 OIDC

> 本稿是第一版设计经代码对照评审后的修订版。第一版有多处对现网的描述失真（`fc_status` 枚举名、CodeUp 的现状、构建触发方向、产物路径归属），以及两个会变成事故的安全默认（部署即公网、`third` 静默降级）。逐条修订见 §12。**文中所有对现网行为的陈述都带 `file:line`，实现时以代码为准，不以本文为准。**

---

## 1. 背景与目标

### 1.1 现状（已核对代码，不是回忆）

- **apps 现在没有 git 远端。** 播种只是把模板写进工作目录：`apps/daemon/src/sync/app_seed.rs:3` —— "There is no remote and no local repo… the local `git init` + scaffold commit that replaced it went with the rest of git"。`app_clone.rs:3` 同样记录 managed-git 与老 app remote 已被删除，`git clone` 只剩"创建时按用户填的 URL 一次性导入"这一个用途。
- **发布链路由桌面端串行编排**，daemon 只是本机的一个构建 RPC：`packages/app/src/stores/apps-store.ts:174` 调云端 `deployApp` → `:178` 经 loopback 调本机 daemon `POST /v1/apps/build`（`apps/daemon/src/http/apps.rs:349`）→ 再由桌面调云端 `finalizeDeploy`。**daemon 没有云端身份，也没有服务端→daemon 的任务通道。**
- **产物路径由服务端推导且固定**：`apps/{appId}/code.zip`（`services/fc/src/lib/provisioning/app-deploy.ts:6`；finalize 处重新推导见 `pg-repo/apps.ts:273`；daemon 侧 `app_build.rs:14` 硬编码同一 key）。daemon 只拿到一个 presigned PUT。
- **deploy / finalize 是 creator-only**：`pg-repo/apps.ts:232`、`:259`，非创建者返回 null → 路由 404。
- **已部署的 app 在 vanity 域上是公开的**：反代只检查 `fc_status === "live"`，不看 visibility、不做鉴权（`apps-vanity.ts:115`）。

所以本设计的真实 delta **不是"把 CodeUp 换成 Gitea"**（CodeUp 已经不在这条链路上了），而是：

1. 从零引入源码远端 —— **自建 Gitea**，并在 daemon 里重建 git 能力（init / remote / fetch / checkout / push / 凭证注入 / dirty 检测）。
2. 把发布从"构建工作目录里的任何东西"收紧为 **构建 Gitea 上已存在的某个 commit**。
3. 登录：TeamClaw 控制面沿用现有登录；每个 app 可选 `auth_mode`，`platform` 时在 saas-mono GoTrue 为该 app 注册独立 OAuth 客户端。
4. 运行时 Phase 1 只做 **Node 代码包 FC**；模型预留 `runtime=container` 供 Python 等自定义容器后置。

### 1.2 已锁定决策

| 维度 | 决策 |
|------|------|
| 客户 | TeamClaw 内团队用户（非另交付迷你 PaaS） |
| Git | 纯 Gitea（不做 Phase 1 GitForge 抽象 / CodeUp fallback） |
| 构建算力 | **一律 daemon**；中心不养 build worker；daemon 离线则无法发版 |
| **构建触发** | **桌面端编排，沿用现网方向**：桌面 → 云端 start → 本机 daemon build → 桌面 → 云端 finalize。**不新建服务端→daemon 通道**（见 §5.1） |
| **谁能发版** | **发起部署的那台桌面 + 它的本机 daemon**；权限沿用 creator-only（见 §5.6） |
| 产物路径 | Gitea（源码）→ daemon build → OSS zip → 更新 per-app FC |
| **产物 key 归属** | **始终由服务端推导**；daemon 不上报路径（见 §5.4） |
| 运行时 Phase 1 | `runtime=node`（代码包 / custom runtime） |
| 运行时预留 | `runtime=container` 字段预留；创建时不可选；部署若误选则拒绝 |
| 控制面登录 | 默认后端（`BACKEND_KIND=supabase`）走 saas-mono GoTrue；自托管后端是 Better Auth，见 §6.7 |
| App 登录 | `auth_mode`: `none` \| `platform` \| `third` |
| Platform OAuth | 每 app 独立 OAuth 客户端；**仅在切到 `platform` 时创建** |
| **`third` Phase 1** | UI 可选、可存库、**拒绝部署**（不再按 `none` 静默降级，见 §6.4） |
| **公开性** | `auth_mode=none` 即公网可达，**必须在 UI 上显式确认**（见 §7） |
| 目标态 C | env 面板、自定义域名、部署历史/回滚、用量配额 — 后置 |

---

## 2. 总览与职责

| 组件 | Phase 1 职责 |
|------|----------------|
| **TeamClaw 控制面（FC Cloud API）** | 登录/org/team；Apps CRUD；Gitea 建仓；阿里云 FC 函数 ensure/更新；RDS schema；`startDeploy` / `finalizeDeploy`；GoTrue OAuth 客户端 CRUD（`platform`） |
| **Gitea** | per-app 私有仓；存代码与 commit；**不**跑构建 |
| **桌面端（packages/app）** | **发布流程的编排者**：调 start → 调本机 daemon 构建 → 调 finalize；失败时回写 `fc_status=deploy_error` |
| **amuxd daemon** | 本机构建 RPC：checkout 目标 sha、`pnpm install && pnpm build`、zip、PUT 到 presigned URL。**不与云端直接通信** |
| **阿里云 RDS** | 控制面 `supabase_db`；apps 共享库内 schema-per-app（仅需库的类型） |
| **阿里云 FC** | 每 app 一个 HTTP 函数；跑 Node 构建产物 |
| **saas-mono GoTrue** | 控制面登录；app 可选 `platform` 时的 OAuth 授权服务器 |

**发布前置条件（写死）：**

1. 目标 commit 已在 Gitea；
2. 发起部署的这台机器上，该 app 的 workspace 存在，且本机 daemon 在线。

```text
Gitea（源码 / commit）
  → 桌面端发起部署 → 云端 startDeploy（建/取函数 + 签发 presigned PUT）
  → 本机 daemon：fetch + checkout 该 sha → 构建 → zip → PUT 到 OSS
  → 桌面端 → 云端 finalizeDeploy（sha 作为入参；OSS key 由服务端推导）
  → 更新 per-app FC 函数代码包 → live URL
```

---

## 3. 数据模型与状态机

### 3.1 `amux.apps` 扩展（在现有表上）

| 字段 | Phase 1 | 说明 |
|------|---------|------|
| `git_remote_url` / `git_auth_kind` | 用 | 指向 **Gitea** 仓 |
| `git_commit_sha` | 新增 | 当前成功部署绑定的 commit |
| `runtime` | 新增，默认 `node` | `node` \| `container`；Phase 1 只允许创建/部署 `node` |
| `auth_mode` | 新增，默认 `none` | `none` \| `platform` \| `third` |
| `oauth_client_id` | 新增，可空 | `platform` 时写入；公开 |
| `oauth_app_id` | 可空 | GoTrue 侧 `auth.oauth_clients.id`，用于禁用/删除 |
| `fc_*` / `provision_*` | 沿用 | 播种 vs 部署两套状态机正交 |
| 容器字段（如 `image_repo`） | 可空预留，Phase 1 不写 | 避免二次迁表 |
| OAuth client secret | **不进 `amux.apps`** | 存放形态见 §6.3（Phase 1 必须定形，不能留白） |

**每加一个字段要同步改 4 处**，漏一处的表现是字段静默为 null，不报错：

1. drizzle schema `services/fc/src/db/schema/apps.ts`
2. `amux` schema 的 SQL 迁移（`services/supabase/migrations/`）
3. pg-repo 的 `mapApp`（`services/fc/src/lib/pg-repo/apps.ts:38`）
4. supabase-repo 的**手写列名字符串** `APP_COLUMNS` + 其 mapper（`services/fc/src/lib/supabase-repo/shared.ts:103`）

两条后端路径都在跑，且默认是 `supabase`（`services/fc/src/lib/backend-kind.ts:9`）。

### 3.2 生命周期（枚举名以现网为准）

```text
provision_status:  pending → repo_created → seeding → ready | error
fc_status:         not_deployed → awaiting_build → building → deploying → live | deploy_error
```

`fc_status` 的合法转移是白名单强校验（`services/fc/src/lib/provisioning/app-fc-status.ts:5`），非法转移在 `updateApp` 是 400、在 `finalizeDeploy` 是 409（`pg-repo/apps.ts:211`、`:262`）。NULL 等价于 `not_deployed`。**第一版设计写的 `idle` / `error` 在现网不存在，已废弃。**

### 3.3 发布规则

1. 仅 `provision_status=ready`、`runtime=node`、`auth_mode ∈ {none, platform}`、本机 daemon 在线时可点「部署」。
2. daemon 必须基于 **Gitea 上已存在的 commit** 构建；工作树有未提交/未 push 变更时拒绝，提示先 commit + push。
3. 成功后写入 `git_commit_sha`、`fc_endpoint`、`fc_status=live`。
4. `auth_mode=platform`：finalize 注入该 app 的 OAuth env，并确保 redirect 指向当前 **vanity** callback（§6.2）。
5. `auth_mode=none`：不注入 OAuth env；此时 app 是公网可达的（§7）。
6. `auth_mode=third`：**拒绝部署**，返回明确原因。

---

## 4. Gitea 建仓与凭证

### 4.1 拓扑

- **一台共享 Gitea**（平台运维），不是每客户一套。
- 每个 app 一个私有仓；命名固定为 `tc-app-{appId}`。
- **单一 Gitea org/owner**（如 `teamclaw-apps`）。不做 per-team Gitea org（Phase 1）。

### 4.2 建仓

控制面在 `createApp` 时调 Gitea API 建空私有仓，写回 `git_remote_url`、`git_auth_kind`，`provision_status → repo_created`。

### 4.3 凭证 JIT（不进库、不上桌面、**必须限定到单仓**）

| 项 | 决策 |
|----|------|
| 形态 | **限定到该仓的 Gitea 凭证**：per-repo fine-grained token，或 per-repo deploy key |
| 下发 | JIT：`GET /v1/apps/:appId/git-credential`（Apps 专用；按 app 而非按 team 授权） |
| 谁能拿 | 该 app 的可部署者（§5.6）；仅本机 daemon 经桌面端取用 |
| 存储 | **不入库**；内存使用后丢弃 |
| 有效期 | 短期，覆盖一次 fetch/push 即可 |

> **为什么不能是平台 bot 的全局 PAT。** 所有 app 仓在同一个 org 下，一个全局 bot PAT 一旦下发到某个 team 成员的机器上，就能读写**其它所有 team 的 app 仓**。"仓库私有 + token 权限隔离"在单 org 拓扑下只有在 token 本身限定到单仓时才成立。这一条是 Phase 1 的硬要求，不是优化项。

### 4.4 播种与开发

1. daemon `git init` → 写模板（含 `AGENTS.md` 与 auth 说明）→ 加 remote → 首 commit → push → `provision_status=ready`。
   （注意：这套 git 能力现在**不存在**，`app_seed.rs` 只写文件。是新代码。）
2. 之后在 workspace 改代码，**commit + push 到 Gitea**。
3. 「部署」只构建已在远端的 commit。

### 4.5 与 CodeUp / team-share

- 新 app 仓只走 Gitea。
- team-share 的 managed-git / CodeUp 本 phase 不动。
- Phase 1 **不**做 GitForge 抽象；换 forge 留到有第二个一等实现时再抽。

### 4.6 运维配置

`GITEA_URL`、bot 凭证、默认 org 名需要**三写**，缺一不可：

1. `services/fc/s.yaml` 的 `environmentVariables:`
2. `deploy/self-host/docker-compose.yml` 中 fc 服务的 `environment:`（这是个**允许列表**，不在里面的变量永远到不了容器）
3. `deploy/self-host/.env.example`

漏任何一处，`services/fc/test/deploy-env-parity.test.ts` 直接失败（它同时还会检查"声明了但 src/ 里没人读"的孤儿变量）。缺失时建 app 返回 503，错误信息里要点名是哪个变量为空——沿用 `deployUnavailable(reason)` 的做法（`app-deploy.ts:20`）。

---

## 5. 发布链路

### 5.1 触发方向（决策：沿用现网，不新建通道）

**桌面端是编排者**，链路与现网一致，只在中间插入 git 语义：

```text
桌面 UI「部署」
  → 云端 POST /v1/apps/:id/deploy        （校验 → fc_status=awaiting_build → 返回 presignedPut）
  → 本机 daemon POST /v1/apps/build      （loopback；新增 gitCommitSha / gitRemoteUrl / 凭证）
  → 云端 POST /v1/apps/:id/deploy/finalize（桌面调用，带 gitCommitSha）
```

**为什么不做"任一在线 daemon 领取构建任务"**：那需要新增一条服务端→daemon 的推送通道，并给 daemon 发放云端身份凭证——两件都是新的鉴权面，而收益只是"换台机器也能发版"。Phase 1 明确不做；代价是**必须在装有该 app workspace 的那台机器上发版**，这与"daemon 离线 = 不能发版"是同一类已接受的约束。

### 5.2 daemon 构建步骤（唯一构建器）

1. 工作树若有未提交/未 push 变更 → **拒绝**（提示先 commit + push）。
2. `git fetch` + checkout 目标 `sha`（该 sha 必须已在 Gitea）。
3. `pnpm install --frozen-lockfile && pnpm build`，zip `.output`（沿用 `app_build.rs:60-62`）。
4. PUT 到桌面端透传的 presigned URL。

### 5.3 目标 sha 从哪来

Phase 1：**app 默认分支在 Gitea 上的当前 head**，由桌面端在发起部署前向 Gitea 查询并带入整条链路。不做"用户手选 commit"（那属于部署历史/回滚，Phase 2）。sha 必须在 `startDeploy` 之前确定，因为它要一路带到 finalize。

### 5.4 产物 key 与 finalize 的信任边界

**`ossObjectName` 始终由服务端推导，daemon / 桌面端不上报路径。**

第一版设计让 daemon 上报 `ossObjectName`，那是把一个服务端推导值（`app-deploy.ts:6`）改成客户端可控值，而 finalize 会把它直接交给 `ensureFunction`（`app-deploy.ts:100`）——没有前缀校验的话，一个 app 可以把 finalize 指向另一个 app 的产物并部署它。

Phase 1 的做法：

- `finalizeDeploy` 的入参新增 `gitCommitSha`（**只是数据**，写回 `apps` 行），路径仍在服务端拼。
- 若后续为了区分版本而改用 `apps/{appId}/deploy-{sha}.zip`，那也**由服务端用同一个 sha 拼出来**，并且 `startDeploy` 与 `finalizeDeploy` 必须用同一个推导函数，保证签发的 PUT 与 finalize 读取的 key 一致。
- 无论哪种，服务端都要强制 key 落在 `apps/{appId}/` 前缀内。

### 5.5 并发、顺序与幂等

现网没有任何并发控制：OSS key 固定 → 两次部署互相覆盖；finalize 无版本号 → 乱序到达会把旧产物写成 live，而库里的 `git_commit_sha` 会与 FC 上真正跑的那份不符。Phase 1 至少要有：

- **单飞**：同一 app 已有部署在途（`fc_status ∈ {awaiting_build, building, deploying}`）时，`deployApp` 返回 409 而不是再签一个 PUT。桌面端已有 `deployingIds` 的本地去重（`apps-store.ts:169`），但那只挡本机、不挡另一台机器。
- **顺序**：`finalizeDeploy` 带上 `startDeploy` 返回的 deploy 标识（或 sha），与库中在途的那次不匹配则拒绝。
- **超时回收**：任一在途状态（`awaiting_build` / `building` / `deploying`）停留超过 presign 有效期即可判定为失败（见 §5.7），否则一次桌面崩溃就让行永久卡住。只回收 `awaiting_build` 是不够的：finalize 会先把行写成 `deploying` 再去调 FC，进程死在那一步的行没有任何出路。

### 5.6 谁能发版

沿用现网的 **creator-only**（`pg-repo/apps.ts:232`、`:259`）。第一版设计写的"任一 team 成员的 daemon 都能构建"与现网授权模型相反，且在 §5.1 的决策下也没有意义（构建必须发生在有该 workspace 的那台机器上）。

若之后要放开到 team 成员，需要一并想清楚 `visibility=personal` 的 app 是否允许他人部署——这两件事现在是耦合的。

### 5.7 构建的资源边界（Phase 1 必须有，现在一条都没有）

| 问题 | 现状 | Phase 1 要求 |
|------|------|--------------|
| 构建超时 | `Command::output()` 无 timeout（`app_build.rs:38`），`pnpm install` 卡住就永久挂住 loopback 请求 | 给 install / build 各设超时，超时后杀进程并回报可读原因 |
| 产物体积 | `zip_dir` 把整个 `.output` 读进 `Vec<u8>`（`app_build.rs:18`）再整块 PUT | 设上限并在超限时明确报错；上限需对齐 FC 代码包限制（实现前查阿里云当前配额） |
| presign 有效期 | 30 分钟（`services/fc/src/index.ts:98`，`expiresIn: 1800`），且在构建**开始前**签发 | 整条 fetch + install + build + upload 必须在这 30 分钟内完成；超时的表现是 403，UI 现在只会说"构建或上传失败"（`apps-store.ts:180`），要能区分出"签名过期"这一类 |
| 编排中断 | 部署逻辑活在 zustand action 里，桌面关闭/切页即中断，行停在 `awaiting_build` | 配合 §5.5 的超时回收 |

### 5.8 构建契约与"自助"的冲突

`build_artifact` 硬编码 `pnpm install --frozen-lockfile` + `pnpm build` + zip `.output`。这对平台模板成立，但本设计的前提是**客户自主编写**：

- 用户加了依赖但忘记提交更新后的 `pnpm-lock.yaml` → `--frozen-lockfile` 直接失败；
- 产物不落在 `.output` → zip 到空目录或报一个难懂的错。

Phase 1 的最小要求：这两种失败必须有**指名道姓的错误信息**（"lockfile 与 package.json 不一致，请提交更新后的 pnpm-lock.yaml" / "构建产物不在 .output/"），而不是把 stderr 原样丢进 toast。是否放开自定义 build 命令留到 Phase 2 的 env/构建配置一起做。

### 5.9 容器预留（非 Phase 1 实现）

Node 代码包 FC vs 自定义容器 FC 的差别在于产物（zip vs 镜像）、构建工具链（pnpm vs Docker+ACR）与语言天花板。Phase 1 只实现 Node；`runtime=container` 留待 Phase 1.5（Python 模板 + 自定义容器）。

---

## 6. App 可选登录（`auth_mode`）

### 6.1 枚举

| 值 | 含义 | Phase 1 |
|----|------|---------|
| `none` | 不集成登录 | 实现；默认；**公网可达，需显式确认（§7）** |
| `platform` | 平台自有 GoTrue；**每 app 独立 OAuth 客户端** | 实现 |
| `third` | 第三方 IdP / OAuth | UI 可选、存库、**拒绝部署** |

TeamClaw 控制面登录与 app `auth_mode` 无关。

### 6.2 redirect URI 用 vanity 域，不是 `fc_endpoint`

**redirect URI = `https://<slug>-<id8>.<APPS_PUBLIC_DOMAIN>/auth/callback`**（`appPublicUrl`，`services/fc/src/lib/apps-public-host.ts`）。

第一版设计写的 `{fc_endpoint}/auth/callback` 是错的，三个理由：

1. `fc_endpoint` 是裸 FC 触发器地址，不是产品对外发出去的地址；vanity 域经反代转发到它（`apps-vanity.ts`），`apps-store.ts:191` 的注释专门记过这件事。
2. FC 默认域名会给每个响应盖 `Content-Disposition: attachment`（`apps-vanity.ts:135`），登录回调页会被浏览器当文件下载。
3. `slug` 在重命名时不变（`updateApp` 不改 slug，`pg-repo/apps.ts:195`），所以 vanity 域是稳定的，而 `fc_endpoint` 是实现细节。

**边界情况**：`APPS_PUBLIC_DOMAIN` 为空时 `appPublicUrl` 返回 null，该部署没有 vanity 域。此时 `auth_mode=platform` **不可用**，创建/部署时明确报错，而不是退回 `fc_endpoint`。

**模板契约**：app 跑在反代后面，`Host` 是 FC 的。模板自拼 `redirect_uri` 必须走 forwarded header（或直接用注入的 `APP_PUBLIC_URL` env），否则拼出来的 redirect 与 IdP 登记的不一致。

### 6.3 client secret 的存放形态（Phase 1 必须定，不能留白）

**约束（来自代码）**：`finalizeDeploy` 每次都**重建整个 env map**（`app-deploy.ts:84`），而 `ensureAppSchema` 每次部署都轮换 DB 密码并要求在同一次 `ensureFunction` 里写回（`app-postgres.ts` 的注释解释了为什么必须如此）。

**推论**：OAuth client secret 必须在**每一次 finalize** 都能被控制面读到。"只在创建时注入一次、之后不再持有"是不成立的——第二次部署就会把它从 env 里抹掉。

**Phase 1 的做法**：控制面持有一个可读的密钥存储。二选一，实现计划里定：

- **A（推荐）**：新表 `amux.app_secrets`（`app_id` + `kind` + 密文），用一把部署级 KMS/对称密钥加密，密钥来自 env。控制面在 finalize 时解密后写入 FC env。
- **B**：不自己存，每次 finalize 向 GoTrue 重新轮换该客户端的 secret 并立即写入 env。省掉一个存储，但每次部署都会使旧 secret 失效（部署期间的登录会中断），且依赖 GoTrue 提供轮换接口。

无论哪个，**明文都不进 `amux.apps`、不进 Gitea、不进日志**。第一版设计里的"密钥槽"是个没有定义的名词，本节替换它。

### 6.4 `third` 拒绝部署，而不是按 `none` 发出去

第一版让 `third` "部署行为与 `none` 相同"。叠加 §7 的公开性，这条的实际效果是：用户在 UI 上选了"第三方登录"、看到"已保存"，然后平台把一个**无登录墙的公网页面**发了出去。这是静默降级成不安全状态，Phase 1 不接受。

改为：`auth_mode=third` 时部署按钮禁用，或 `deployApp` 返回 409 + "third-party 登录尚未支持，请先切换到 platform 或 none"。

### 6.5 `platform`：独立 OAuth 客户端

**不**使用全平台共享 OAuth client。每个 `platform` app 在 GoTrue 拥有：

| 项 | 处理 |
|----|------|
| `oauth_client_id` | 可入库 / 注入前端 |
| client secret | 见 §6.3；明文不进 `amux.apps`、不上 Gitea |
| redirect URI | vanity callback（§6.2） |
| 元数据 | 关联 `app_id` / `team_id` |

**创建时机**：仅当用户将 `auth_mode` 设为 `platform`（首次）时注册。

```text
auth_mode → platform（首次）
  → 在 GoTrue 注册 OAuth 客户端
  → 回写 oauth_client_id / oauth_app_id
  → secret 进入 §6.3 的存储；redirect 可先占位

部署 finalize（auth_mode=platform）
  → 更新 redirect = 当前 vanity callback
  → 注入 CLIENT_ID / SECRET / APP_PUBLIC_URL / API_BASE（无 service role）

auth_mode → none | third
  → 禁用（推荐）GoTrue 侧客户端
  → 再部署时去掉 platform OAuth env

删除 app
  → 级联禁用/删除对应 OAuth 客户端
```

### 6.6 模板与鉴权约定

- `platform`：模板用本 app `client_id` 走授权码 + PKCE；受保护路由无会话则跳转登录。
- 默认收紧：仅**该 app 所属 team/org 成员**可进入。成员校验需要一个明确的接口契约（app 用终端用户的 token 调 Cloud API 的某个 `/v1/apps/:id/membership` 类端点；app 自身不持有 service role）——**这个端点现在不存在，实现计划里要列为新增项**。
- `none`：无登录墙，见 §7。

### 6.7 两种控制面后端

`BACKEND_KIND` 默认 `supabase`（`backend-kind.ts:9`），走 saas-mono GoTrue —— 本节所有 `platform` 设计针对的是这条路径。

自托管盒子（`BACKEND_KIND=postgres`）用的是 **Better Auth**（`services/fc/src/auth/better-auth.ts`），其插件集里的 `genericOAuth` 是 OAuth **客户端**（用第三方登录进来），不是授权服务器。**自托管形态下 `auth_mode=platform` Phase 1 不可用**，创建时应直接不提供该选项并说明原因。第一版设计通篇没有区分这两个部署形态。

### 6.8 安全底线

- 禁止 supabase service role 注入客户 app。
- redirect 以 IdP 侧登记 URI 为准。
- OAuth token 不写回 `amux.apps`。

---

## 7. 公开性：默认值必须显式化

**现状**：vanity 反代不做任何鉴权、也不看 visibility，只要 `fc_status === "live"` 就对公网服务（`apps-vanity.ts:115`）。而 `visibility` 默认 `personal`（`db/schema/apps.ts:13`）、`auth_mode` 默认 `none`。

**后果**：自助用户建的一个"个人" app，一旦部署就在公网上，主机名是 `<slug>-<id8>.<domain>`，slug 来自 app 名、id 前缀只有 8 位十六进制——可枚举。用户会合理地以为 "personal" 意味着私有。

**Phase 1 要求**（这是本次评审新增的一节）：

1. `auth_mode=none` 的部署，UI 上必须有一次**显式确认**，文案点明"任何拿到链接的人都能访问"。
2. app 详情页常驻展示当前公开状态，不能只在创建时提一句。
3. `visibility=personal` 与 `auth_mode` 的关系要在 UI 上说清：**visibility 管的是控制面里谁看得见这个 app，不是线上页面谁访问得了**。两者同名不同义是当前最容易误解的地方。
4. 验收标准里不再把"无需登录可打开"单独当作通过条件（见 §9.4）。

不在 Phase 1 范围：给 `none` 的 app 加平台级访问控制（那是 Phase 2 的域名/访问策略）。

---

## 8. 路线图

| 阶段 | 交付 |
|------|------|
| **Phase 1（本次）** | Gitea 建仓 + daemon 侧 git 能力；桌面编排的 commit-bound 发布；一律 daemon 构建 → OSS → Node FC；RDS schema-per-app（需库类型）；`auth_mode` none/platform（third 占位且拒绝部署）；公开性显式化；构建资源边界；live URL；`runtime` 预留 container |
| **Phase 1.5** | 自定义容器 FC + Python 模板；`runtime=container` 可部署（本机需 Docker） |
| **Phase 2（目标态 C）** | 环境变量面板；自定义域名；部署历史/回滚（sha 命名产物在此真正有用）；用量与配额提示（仍不引入中心构建池）；自定义 build 命令 |
| **之后** | `third` 真接通用 OIDC；服务端→daemon 通道（若"换台机器发版"成为真实诉求）；CodeUp/team-share 与 Gitea 关系再议 |

---

## 9. Phase 1 验收标准

1. 创建 app → Gitea 私有仓存在 → 模板播种并 push 成功 → `provision_status=ready`；仓内首个 commit 可在 Gitea 上看到。
2. 下发的 git 凭证只能访问该 app 的仓：用 app A 的凭证访问 app B 的仓被拒绝。
3. 本机 daemon 在线时可部署；产物绑定 Gitea 上已存在的 commit；成功后 `git_commit_sha` 与 Gitea head 一致，且有可打开的 vanity URL。
4. 工作树有未 push 变更时部署被拒绝，提示可读。
5. daemon 离线时部署失败且原因可见。
6. 同一 app 并发部署时第二次返回 409，不产生互相覆盖的产物。
7. 构建超时 / 产物超限 / presign 过期三种失败各自有可区分的错误信息。
8. `auth_mode=none`：部署前出现公开性确认；app 详情页常驻显示"公开"。
9. `auth_mode=platform`：GoTrue 出现独立 OAuth 客户端；终端用户可用平台账号登录并落在 **vanity 域**的回调上；连续部署两次后登录仍可用（验证 §6.3 的 secret 存放是对的）；secret 不落库明文。
10. `auth_mode=third`：可保存；部署被拒绝且原因可读。
11. 创建时不可选 `container`；仅 `node` 可部署。
12. `APPS_PUBLIC_DOMAIN` 为空的部署上，`auth_mode=platform` 被明确拒绝而不是静默用 `fc_endpoint`。
13. 新增 env 三写到位，`deploy-env-parity.test.ts` 通过。

---

## 10. 与既有规格的关系

- Phase 1/2 Apps 设计中的 **FC 控制面 + daemon 构建器 + OSS + schema-per-app** 仍然成立；本设计新增源码远端（Gitea），把发布收紧为"绑定远端 commit"，并明确构建触发方向不变。
- `2026-07-28-app-types-design.md` 的类型与「一条部署流水线、多模板」继续适用；OAuth 与 runtime 字段叠加在其上。
- team-share managed-git（CodeUp）本 phase 不迁移。注意：apps 这条链路上的 CodeUp **已经被删除**，不是本设计要迁移的对象（§1.1）。

---

## 11. 开放依赖（实现前需确认）

1. **GoTrue OAuth 授权服务器是否已启用。**（第一版把这条写成"是否要排期做"，实际比想象中近）saas-mono 的 GoTrue 已在 v2.189.0，`auth.oauth_clients` 表已存在——`saas-mono/docs/database/migrations/2026-06-11_add-oauth-client-id-to-auth-sessions.sql` 给 `auth.sessions.oauth_client_id` 建了指向它的外键。**剩下的是配置/运维确认**：生产实例上该能力是否打开、客户端注册与 redirect 更新的 admin 接口是否对 TeamClaw 暴露、secret 能否轮换（决定 §6.3 选 A 还是 B）。这是半天能验证完的事，不是一个 epic。
2. 共享 Gitea 实例的部署位置、备份与 bot 账号运维归属；以及 Gitea 版本是否支持 per-repo fine-grained token（§4.3 的硬要求）。
3. FC 代码包体积上限的当前配额（§5.7）。
4. `/v1/apps/:id/membership` 类端点的契约（§6.6），现在不存在。

---

## 12. 本次修订记录（第一版 → 本版）

对照 teamclaw 现网代码逐条核对后的改动：

| # | 第一版 | 本版 | 依据 |
|---|--------|------|------|
| 1 | `fc_status: idle → … → error`，称"与现网对齐" | 改为 `not_deployed → … → deploy_error` | `app-fc-status.ts:5` |
| 2 | "Git 从 CodeUp 换成 Gitea" | 改为"从无远端到有远端"；delta 是在 daemon 里重建 git 能力 | `app_seed.rs:3`、`app_clone.rs:3` |
| 3 | daemon 领取构建任务、daemon 调 finalize | 改为桌面端编排（§5.1），明确列入 non-goals | `apps-store.ts:174-196`、`daemon/src/http/apps.rs:349` |
| 4 | "任一在线 daemon 均可构建" | 撤回；沿用 creator-only（§5.6） | `pg-repo/apps.ts:232`、`:259` |
| 5 | daemon 上报 `ossObjectName` | 撤回；路径始终服务端推导（§5.4） | `app-deploy.ts:6`、`pg-repo/apps.ts:273`、`app-deploy.ts:100` |
| 6 | secret "仅注入 FC env、不入库"，存放形态叫"密钥槽" | 定形为 §6.3 的 A/B 两案 | `app-deploy.ts:84`、`app-postgres.ts` |
| 7 | redirect = `{fc_endpoint}/auth/callback` | 改为 vanity 域；补 `APPS_PUBLIC_DOMAIN` 为空的分支 | `apps-public-host.ts`、`apps-vanity.ts:135`、`apps-store.ts:191` |
| 8 | `third` 部署行为等同 `none` | 改为拒绝部署（§6.4） | 静默降级成不安全状态 |
| 9 | 未提及公开性 | 新增 §7 | `apps-vanity.ts:115`、`db/schema/apps.ts:13` |
| 10 | 未提及并发/超时/体积 | 新增 §5.5、§5.7 | `app_build.rs:18,38`、`index.ts:98` |
| 11 | 未提及自助与模板契约冲突 | 新增 §5.8 | `app_build.rs:60-62` |
| 12 | 未区分两种控制面后端 | 新增 §6.7 | `backend-kind.ts:9`、`auth/better-auth.ts` |
| 13 | "字段新增"一笔带过 | 点明 4 处同步改动 | `supabase-repo/shared.ts:103` |
| 14 | env 双写 | 改为三写（含 `.env.example`） | `deploy-env-parity.test.ts` |
| 15 | Gitea 凭证 = 平台 bot PAT | 改为 per-repo 限定凭证，并说明为什么 | 单 org 下全局 PAT = 跨 team 越权 |
| 16 | §10.1 "saas-mono 是否有 OAuth 注册 API" | 收敛为配置确认项（§11.1） | saas-mono GoTrue v2.189.0 + `auth.oauth_clients` |
