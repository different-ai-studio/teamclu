# Apps 自助发布 — Gitea + Node FC + 可选 Platform OAuth

- **Date**: 2026-08-27
- **Status**: Design approved in brainstorming; ready for implementation planning after user review
- **Branch**: `docs-apps-self-serve-gitea-fc`
- **Path**: `docs/specs/2026-08-27-apps-self-serve-gitea-fc-design.md`（`docs/superpowers/` 在本仓库被 gitignore，故落在 `docs/specs/`）
- **Scope**: TeamClaw 团队用户在平台内创建、开发、发布、维护自己的 app（自助闭环）。Phase 1 交付可演示路径；目标态对齐近自助 PaaS（env / 域名 / 配额后置）。
- **Builds on**: `docs/specs/2026-06-14-apps-module-design.md`、`docs/specs/2026-06-14-apps-module-phase2-design.md`、`docs/specs/2026-07-28-app-types-design.md`
- **Non-goals (Phase 1)**: 中心 build worker、Gitea Actions 构建、自定义容器部署、环境变量面板、自定义域名、配额 UI、per-team Gitea org、GitForge 抽象、CodeUp fallback、`third` 真接 OIDC

---

## 1. 背景与目标

现有 Apps 模块已具备控制面 CRUD、daemon 播种/构建、OSS 交接、per-app 阿里云 FC、RDS schema-per-app 等骨架；Git 侧规格仍偏向 CodeUp managed-git。本设计把「客户自主编写 / 发布 / 维护」收成一条产品路径：

1. 源码真相源改为 **自建 Gitea**（新 app 仓不再走 CodeUp）。
2. 发布链路为 **Gitea commit → daemon 构建 → OSS → Node FC**。
3. 登录：TeamClaw 控制面 **必须** 走 saas-mono Supabase OAuth；每个 app 可选 `auth_mode`，`platform` 时在 saas-mono **为该 app 创建独立 OAuth 应用**。
4. 运行时 Phase 1 只做 **Node 代码包 FC**；模型预留 `runtime=container` 供 Python 等自定义容器后置。

### 1.1 已锁定决策

| 维度 | 决策 |
|------|------|
| 客户 | TeamClaw 内团队用户（非另交付迷你 PaaS） |
| Git | 纯 Gitea（不做 Phase 1 GitForge 抽象 / CodeUp fallback） |
| 构建 | **一律 daemon**；中心不养 build worker；daemon 离线则无法发版 |
| 产物路径 | Gitea（源码）→ daemon build → OSS zip → 更新 per-app FC |
| 运行时 Phase 1 | `runtime=node`（代码包 / custom runtime） |
| 运行时预留 | `runtime=container` 字段预留；创建时不可选；部署若误选则拒绝 |
| 控制面登录 | saas-mono / GoTrue（强制） |
| App 登录 | `auth_mode`: `none` \| `platform` \| `third` |
| Platform OAuth | 每 app 独立 OAuth 应用；**仅在切到 `platform` 时创建** |
| `third` Phase 1 | UI 可选、可存库、提示未支持；**部署按 `none` 对待** |
| 目标态 C | env 面板、自定义域名、部署历史/回滚、用量配额 — 后置 |

---

## 2. 总览与职责

| 组件 | Phase 1 职责 |
|------|----------------|
| **TeamClaw 控制面（FC Cloud API + saas-mono）** | 登录/org/team；Apps CRUD；Gitea 建仓；阿里云 FC 函数 ensure/更新；RDS schema；`finalizeDeploy`；saas-mono OAuth 应用 CRUD（`platform`） |
| **Gitea** | per-app 私有仓；存代码与 commit；**不**跑构建 |
| **amuxd daemon** | clone/pull、播种模板、**唯一构建器**、上传 OSS、触发 finalize |
| **阿里云 RDS** | 控制面 `supabase_db`；apps 共享库内 schema-per-app（仅需库的类型） |
| **阿里云 FC** | 每 app 一个 HTTP 函数；跑 Node 构建产物 |
| **saas-mono OAuth** | 控制面必登；app 可选 `platform` 独立应用 |

**发布前置条件（写死）：**

1. 目标 commit 已在 Gitea；
2. 对应该 app workspace 的 daemon 在线并能完成构建。

```text
Gitea（源码 / commit）
  → daemon 检出该 commit 并构建（本机算力）
  → zip 上传 OSS
  → 控制面 finalize → 更新 per-app FC 函数代码包
  → live URL（fc_endpoint）
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
| `oauth_app_id` | 可空 | saas-mono 侧应用 id，用于禁用/删除 |
| `fc_*` / `provision_*` | 沿用 | 播种 vs 部署两套状态机正交 |
| 容器字段（如 `image_repo`） | 可空预留，Phase 1 不写 | 避免二次迁表 |
| OAuth client secret | **不入库** | 仅注入该 app FC 函数 env / 密钥槽 |

切换 `auth_mode` 允许；**下次成功部署后**线上 env 才与模式一致。

### 3.2 生命周期

```text
provision_status:  pending → repo_created → seeding → ready | error
fc_status:         idle → awaiting_build → building → deploying → live | error
```

（枚举名与现网字段对齐；语义如上。播种走 `provision_*`，部署走 `fc_*`。）

### 3.3 发布规则

1. 仅 `provision_status=ready`、`runtime=node`、daemon 在线可点「部署」。
2. daemon 必须基于 **Gitea 上已存在的 commit** 构建；禁止未入仓本地 dirty 树作为正式产物。
3. 成功后写入 `git_commit_sha`、`fc_endpoint`、`fc_status=live`。
4. `auth_mode=platform`：finalize 注入该 app 的 OAuth env，并确保 redirect 指向当前 callback。
5. `auth_mode=none` 或 `third`（Phase 1）：不注入 OAuth env（`third` 与 `none` 部署行为相同）。

---

## 4. Gitea 建仓与凭证

### 4.1 拓扑

- **一台共享 Gitea**（平台运维），不是每客户一套。
- 每个 app 一个私有仓；命名固定为 `tc-app-{appId}`。
- **单一 Gitea org/owner**（如 `teamclaw-apps`）；用仓库私有 + token 权限隔离。不做 per-team Gitea org（Phase 1）。

### 4.2 建仓

控制面在 `createApp` 时调 Gitea API 建空私有仓，写回 `git_remote_url`、`git_auth_kind`，`provision_status → repo_created`。

### 4.3 凭证 JIT（不进库、不上桌面）

| 项 | 决策 |
|----|------|
| 形态 | 平台 bot 的 Gitea PAT / access token |
| 下发 | JIT：`GET /v1/teams/:id/app-git-credential`（Apps 专用；不与 team-share CodeUp endpoint 混用） |
| 谁能拿 | 该 team 成员；仅 daemon 经 Cloud API 拉取 |
| 存储 | **不入库**；内存使用后丢弃 |

### 4.4 播种与开发

1. daemon clone → 写模板（含 `AGENTS.md` 与 auth 说明）→ 首 commit → push → `provision_status=ready`。
2. 之后在 workspace 改代码，**commit + push 到 Gitea**。
3. 「部署」只构建已在远端的 commit。

### 4.5 与 CodeUp / team-share

- **新 app 仓只走 Gitea。**
- team-share 的 managed-git / CodeUp **本 phase 不动**。
- Phase 1 **不**做 GitForge 抽象；换 forge 留到有第二个一等实现时再抽。

### 4.6 运维配置

`GITEA_URL`、bot token、默认 org 名 → FC env（`deploy/self-host` compose 与 `services/fc/s.yaml` **双写**）。缺失时建 app 返回 503。

---

## 5. daemon 构建 → OSS → Node FC

### 5.1 触发

Apps UI「部署」→ Cloud API 校验 → `fc_status → awaiting_build`（或等价）→ daemon 领取构建任务（现有 RPC/事件通道；**不**新建中心 builder）。

### 5.2 daemon 步骤（唯一构建器）

1. 工作树若有未提交/未 push 变更 → **拒绝部署**（提示先 commit + push）；目标 `sha` 必须已在 Gitea。
2. `git fetch` + checkout 该 `sha`。
3. `pnpm install --frozen-lockfile && pnpm build`（产物契约：可启动的 Node 服务，监听 `$PORT`；与现有模板一致）。
4. 产物打 zip → OSS：`apps/{appId}/deploy-{sha}-{ts}.zip`。
5. `POST /v1/apps/{id}/deploy/finalize`（`ossObjectName` + `gitCommitSha`）。

失败：`fc_status=error` + 可见错误；UI 可重试。

### 5.3 控制面 finalize

1. 从 OSS 更新该 app FC 函数代码包。
2. 确保 HTTP 触发器；回写 `fc_endpoint`、`git_commit_sha`、`fc_status=live`。
3. 按 `auth_mode` 注入或清除 OAuth env（见 §6）。
4. 需库类型：`ensureAppSchema` + `DATABASE_URL`；静态类跳过。

### 5.4 算力与运维含义

- 构建消耗 CPU/内存，由 **客户本机 daemon** 承担。
- **daemon 离线 = 不能发版**（已接受）。
- 多成员：任一装了该 app workspace 且在线的 daemon 均可构建；权限仍走 Cloud API。

### 5.5 容器预留（非 Phase 1 实现）

Node 代码包 FC vs 自定义容器 FC 的差别在于产物（zip vs 镜像）、构建工具链（pnpm vs Docker+ACR）与语言天花板。Phase 1 只实现 Node；`runtime=container` 留待 Phase 1.5（Python 模板 + 自定义容器）。

---

## 6. App 可选登录（`auth_mode`）

### 6.1 枚举

| 值 | 含义 | Phase 1 |
|----|------|---------|
| `none` | 不集成登录 | 实现；默认 |
| `platform` | 平台自有 Supabase（saas-mono）；**每 app 独立 OAuth 应用** | 实现 |
| `third` | 第三方 IdP / OAuth | UI 可选、存库、提示未支持；**部署按 `none`** |

TeamClaw 控制面登录与 app `auth_mode` 无关，始终强制 saas-mono。

### 6.2 `platform`：独立 OAuth 应用

**不**使用全平台共享 OAuth client。每个 `platform` app 在 saas-mono 拥有：

| 项 | 处理 |
|----|------|
| `oauth_client_id` | 可入库 / 注入前端 |
| client secret | **仅** FC 函数 env 或密钥槽；明文不进 `amux.apps`、不上 Gitea |
| redirect URI | `{fc_endpoint}/auth/callback`（随 live URL 更新） |
| 元数据 | 关联 `app_id` / `team_id` |

**创建时机：** 仅当用户将 `auth_mode` 设为 `platform`（首次）时调用 saas-mono「创建 OAuth 应用」API。

### 6.3 生命周期

```text
auth_mode → platform（首次）
  → 创建 saas-mono OAuth 应用
  → 回写 client_id（及可选 oauth_app_id）
  → secret 进入密钥槽；redirect 可先占位

部署 finalize（auth_mode=platform）
  → PATCH redirect = 当前 callback
  → 注入 CLIENT_ID / SECRET / API_BASE 等（无 service role）

auth_mode → none | third
  → 禁用（推荐）saas-mono 侧应用
  → 再部署时去掉 platform OAuth env

删除 app
  → 级联禁用/删除对应 OAuth 应用
```

### 6.4 saas-mono 前提

控制面依赖稳定 API：

1. 创建应用（返回 client_id + secret）
2. 更新 redirect URIs
3. 禁用/删除应用

若 API 尚未就绪：可先落数据模型 + UI，联调阻塞项单独排期（实现计划中标为依赖）。

### 6.5 模板与鉴权约定

- `platform`：模板用本 app `client_id` 走授权码 + PKCE；受保护路由无会话则跳转登录。
- 默认收紧：仅 **该 app 所属 team/org 成员** 可进入（Cloud API 成员校验；app 不拿 service role）。
- `none` / Phase 1 的 `third`：无登录墙。

### 6.6 安全底线

- 禁止 supabase service role 注入客户 app。
- redirect 以 IdP 侧登记 URI 为准。
- OAuth token 不写回 `amux.apps`。

---

## 7. 路线图

| 阶段 | 交付 |
|------|------|
| **Phase 1（本次）** | Gitea 建仓；daemon 播种/开发/push；一律 daemon 构建 → OSS → Node FC；RDS schema-per-app（需库类型）；`auth_mode` none/platform/third（third 占位）；live URL；`runtime` 预留 container |
| **Phase 1.5** | 自定义容器 FC + Python 模板；`runtime=container` 可部署（本机需 Docker） |
| **Phase 2（目标态 C）** | 环境变量面板；自定义域名；部署历史/回滚；用量与配额提示（仍不引入中心构建池） |
| **之后** | `third` 真接通用 OIDC；CodeUp/team-share 与 Gitea 关系再议 |

---

## 8. Phase 1 验收标准

1. 创建 app → Gitea 私有仓存在 → 模板播种成功 → `provision_status=ready`。
2. daemon 在线可部署；产物绑定 Gitea commit；成功后有可打开的 `fc_endpoint`。
3. daemon 离线时部署失败且原因可见。
4. `auth_mode=none`：live URL 无需登录。
5. `auth_mode=platform`：saas-mono 出现独立 OAuth 应用；终端用户可用平台账号登录；secret 不落库明文。
6. `auth_mode=third`：可保存；UI 标明未支持；部署行为与 `none` 相同。
7. 创建时不可选 `container`；仅 `node` 可部署。
8. 新 app **不再**走 CodeUp 建仓。

---

## 9. 与既有规格的关系

- Phase 1/2 Apps 设计中的 **FC 控制面 + daemon 构建器 + OSS + schema-per-app** 仍然成立；本设计把 Git 从 CodeUp 换成 Gitea，并把构建策略明确为「仅 daemon」、发布必须绑定远端 commit。
- `2026-07-28-app-types-design.md` 的类型与「一条部署流水线、多模板」继续适用；OAuth 与 runtime 字段叠加在其上。
- team-share managed-git（CodeUp）本 phase 不迁移。

---

## 10. 开放依赖（实现前需确认）

1. saas-mono 是否已有（或可排期）动态 OAuth 应用注册 / 更新 redirect / 禁用 API。
2. 共享 Gitea 实例的部署位置、备份与 bot 账号运维归属。
3. 现网 `fc_status` / 部署 API 命名与本设计状态机的逐字段对齐（实现计划里对照代码改，不在本设计再发明第二套名字）。
