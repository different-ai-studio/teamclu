# Apps 模块 — 第二期设计（真实 FC + Postgres provisioning + 部署）

- **Date**: 2026-06-14
- **Status**: Approved design, ready for implementation planning
- **Branch**: `agent/apps-module`（接续第一期 + phase-2a 凭证/状态回写）
- **Scope**: 把第一期 §9「第二期预告」落地为可工作的完整部署流水线 —— 用户点
  「部署」后，app 真实跑在一个 **per-app Alibaba FC 函数** 上，连到自己专属的
  **Postgres schema**，可由一个 **live URL** 访问并读写真实数据。
- **Prereqs**: 第一期数据模型（`amux.apps` 含 `fc_*` 占位字段 + `provision_status`
  状态机）+ phase-2a（managed-git 凭证 JIT 投递、状态回写编排）。

---

## 1. 背景与目标

第一期做了 app 骨架：建 app → 开 per-app git 仓库 → 绑 1:1 workspace → daemon
播种 TanStack+Postgres 模板 → 用户/agent 在 session 里写代码。其中「每个 app 对应
一个 FC + 一个 Postgres 库 + 一键部署 + 访问 URL」只在数据模型里占位。

第二期把这块做实，目标是用户能：

1. 在 app 列表里对一个 `provision_status = ready`（已播种）的 app 点 **「部署」**。
2. 系统为它 provision 一个 **专属 Postgres schema + 受限角色**（共享库内隔离）。
3. 系统为它 provision/更新一个 **专属 Alibaba FC 函数**（HTTP 触发）。
4. daemon 把该 app 的代码 **构建** 成可部署产物，经 OSS 交接给 FC。
5. FC 把产物部署到该函数、注入 DB 连接串、跑 app 自带迁移，回填 `fc_*` 字段。
6. app 在一个 **live URL**（`fc_endpoint`）上可访问，读写自己的 Postgres schema。
7. 全过程状态可见、失败不静默吞、可重试。

### 关键决策（brainstorming 已锁定）

| 维度 | 决策 |
|---|---|
| **部署运行时** | per-app Alibaba FC 函数（HTTP 触发，跑 TanStack Start SSR server）。完全匹配 `fc_function_name/fc_region/fc_endpoint` 数据模型，复用现有 AK/SK + `ROLE_ARN`。 |
| **Postgres 模型** | schema-per-app：单个共享库 `teamclu_apps` 内，每 app 一个 schema + 一个仅授权该 schema 的 LOGIN 角色。 |
| **共享库位置** | 与控制面 `supabase_db` **同 RDS 实例、不同 database**（即我们刚迁移的各环境 RDS，dev 上已有 `litellm` 库作先例），新建 database `teamclu_apps`。 |
| **职责划分** | **FC = 特权控制面**（建 schema/role、调 Aliyun FC API、回填字段）；**daemon = 构建器**（有 checkout + Node/pnpm，构建产物上传 OSS）。镜像第一期「FC 建仓、daemon 播种」。 |
| **部署触发** | 桌面 **显式「部署」按钮**（非 push 自动部署）。 |
| **产物交接** | daemon 构建 → OSS（`apps/{appId}/deploy-{ts}.zip`）→ FC 从 OSS 对象建/更新函数代码。双方都已有 OSS 凭证。 |
| **FC SDK** | 官方 `@alicloud/fc20230330` 客户端（不手搓签名）。 |
| **模板** | 复用第一期 `apps/daemon/templates/tanstack-postgres/`，把它做成真实可部署产物（不另起部署模板）。 |

### 既有架构约束（设计依据）

- FC 已持有 `ACCESS_KEY_ID`/`ACCESS_KEY_SECRET`/`REGION`/`ROLE_ARN`/`BUCKET`/
  `ENDPOINT`（今日用于 OSS）—— 同一 AK/SK 可驱动 FC OpenAPI 建函数。
- FC 已持有 `DATABASE_URL`（控制面 `supabase_db` 连接）；新增 `APPS_DB_ADMIN_URL`
  指向同实例的 `teamclu_apps` 库。
- 生产 `BACKEND_KIND=supabase`：任何新 Cloud API 域 **必须同时在 pg-repo 与
  supabase-repo 实现**（第一期 C1 教训）。
- Cloud API 通过 self-host 与 Belayo 各自的 GitHub Action 发布；新增 env 变量
  经 repo secrets/variables 注入，不在本机部署。
- 客户端禁止直连 Supabase；走标准 OpenAPI → routes → business-api → repo →
  contract → provider 链路。
- 失败可见、不静默吞（bootstrap-error-surfacing 教训）。

---

## 2. 数据模型变更

第二期 **不新增表**，只用满第一期已建的 `fc_*` 占位字段，并新增一个 RLS 加固迁移。

### 2.1 `amux.apps` 字段语义（已存在，第二期开始写入）

| 列 | 第二期用法 |
|---|---|
| `fc_function_name` | provision 后写入，固定 `tc-app-{appId}`。 |
| `fc_region` | provision 后写入（默认同 FC `REGION`，如 `cn-shenzhen`）。 |
| `fc_endpoint` | 部署成功后写入 live URL（FC HTTP 触发 URL；自定义域名留后续）。 |
| `fc_status` | **部署生命周期状态机**（见 §4），与 `provision_status`（仓库/播种生命周期）正交。 |
| `provision_error` | 复用为部署失败原因 surface。 |

> `provision_status` 保持第一期语义不变（`pending → repo_created → seeding →
> ready`）；部署阶段全部走 `fc_status`，避免重载一个字段表达两个生命周期。

### 2.2 RLS 递归修复（已在 `ad48f38c` 落地，非第二期新增工作）

第一期 `20260614000000_apps_module.sql` 的策略曾存在 **互相递归**：
`apps_select_if_visible` 的子查询引用 `amux.app_member_access`，而后者的 SELECT
策略又子查询 `amux.apps`，`INSERT...RETURNING` 时触发 Postgres `42P17 infinite
recursion`。

**此问题已修复并提交（commit `ad48f38c`）**，做法：新增 `SECURITY DEFINER` helper
`amux.actor_has_app_access(p_app_id, p_actor_id)`（`search_path` 固定 `amux,public`，
函数内查询绕过 `app_member_access` 的 RLS），把 `apps_select_if_visible` 里的显式
授权子查询替换为对该 helper 的调用，从单边打破环（`app_member_access` 侧无需改）。
helper 直接写在 `20260614000000_apps_module.sql`（in-place 修订，迁移幂等）。

**实例状态（已核实）**：test 与 dev 的 `supabase_db` 均已含 helper 且
`apps_select_if_visible` 已改用 helper。`agent/preview-integration` 亦已并入
`ad48f38c`（含 helper + 客户端 `listApps` limit 由 200 改 100，修 400）。

> 故第二期 **无需** 再为递归单独建迁移；§7 仅保留一条回归测试，确认真实 member
> 数据下 `SELECT` 不再递归。第二期对 apps RLS 的任何新增改动须沿用同样的
> SECURITY-DEFINER-helper 模式，避免引入新的策略环。

---

## 3. 组件与代码落点

### 3.1 FC（`services/fc/`）—— 特权控制面

- **`src/lib/provisioning/app-postgres.ts`**
  - `ensureAppSchema({ appId, slug }) → { connectionString }`
  - 用 `APPS_DB_ADMIN_URL` 连 `teamclu_apps`：`CREATE SCHEMA IF NOT EXISTS
    app_{slug}`；`CREATE ROLE app_{appId} LOGIN`（缺失才建，密码缺失才轮换）；
    `GRANT USAGE/CREATE ON SCHEMA` + 默认权限仅限该 schema；`ALTER ROLE ... SET
    search_path = app_{slug}`。
  - 返回的连接串只在内存里流向 FC 函数 env，**不入库**。
- **`src/lib/provisioning/app-fc-function.ts`**
  - 薄封装 `@alicloud/fc20230330`：`ensureFunction(name, opts)`、
    `updateFunctionCodeFromOss(name, { bucket, object })`、
    `ensureHttpTrigger(name) → url`。
  - 用 `ACCESS_KEY_ID/SECRET` 签名；执行角色用 `ROLE_ARN`；区域用 `REGION`。
- **`src/lib/routes/apps-deploy.ts`**
  - `POST /v1/apps/{id}/deploy`：creator-gated → `ensureAppSchema` →
    `ensureFunction`（注入 `DATABASE_URL` env）→ `fc_status='awaiting_build'`，
    返回 `{ fcFunctionName, fcRegion, ossPrefix }`。
  - `POST /v1/apps/{id}/deploy/finalize`：body `{ ossObjectName }` → `fc_status=
    'deploying'` → `updateFunctionCodeFromOss` → 跑 app 迁移（或 app 自迁移，见
    §5）→ `ensureHttpTrigger` 写 `fc_endpoint` → `fc_status='live'`。
  - 任一步失败 → `fc_status='deploy_error'` + `provision_error`。
- **`repository-contract` / `pg-repo/apps.ts` / `supabase-repo`**
  - 加部署相关状态流转（`fc_status`/`fc_endpoint` 合法流转表，参照 phase-2a 的
    `app-status.ts` 思路），两后端都实现。
- **OpenAPI**：`docs/openapi/teamclu-api.v1.yaml` 增 deploy / finalize 端点。
- **新 env**：`APPS_DB_ADMIN_URL`（+ 复用现有 AK/SK/REGION/ROLE_ARN/BUCKET）。

### 3.2 daemon（`apps/daemon/`）—— 构建器

- **`src/sync/app_build.rs`**
  - `build_app({ appId, workdir }) → { ossObjectName }`
  - 在 app checkout（默认 `~/.amuxd/apps/<appId>`）跑 `pnpm install && pnpm
    build`；把可部署产物 + FC bootstrap 打 zip；上传 OSS
    `apps/{appId}/deploy-{ts}.zip`（复用现有 OSS 引擎 + team secret）。
  - 凭证从 daemon 已有的团队 OSS secret 取；构建产物里 **不含** DB 密钥。
- **`POST /v1/apps/build`** daemon 本地端点（镜像第一期 `/v1/apps/seed`）。

### 3.3 模板（`apps/daemon/templates/tanstack-postgres/`）—— 做成可部署产物

- 加 **FC HTTP 触发 bootstrap**：在 FC nodejs20 custom runtime 下拉起 TanStack
  Start node server（绑定 FC 注入的端口、转发 HTTP 事件）。
- 加 **build 脚本**：`pnpm build` 产出确定的 bundle 目录布局，供 daemon 打包。
- **DB 访问**：经注入的 `DATABASE_URL`（角色已 pin `search_path` 到 app schema）。
- **app 自带初始迁移**：建该 app 的业务表（在自己的 schema 内），首次部署时执行。

### 3.4 桌面（`packages/app/`）

- apps 列表行加 **「部署」按钮**（gated on `provision_status='ready'`）。
- `fc_status` 徽章：`not_deployed / awaiting_build / building / deploying / live /
  deploy_error`（`awaiting_build`/`building` UI 上都呈现为「构建中」即可）。
- `live` 时显示可点的 `fc_endpoint` 链接。
- 编排镜像 phase-2a 的状态回写：调 FC `deploy` → 踢 daemon `build` → 调 FC
  `finalize` → 刷新/轮询状态；失败 surface `provision_error`，可重试。

---

## 4. 部署状态机（`fc_status`）

```
not_deployed
   │ 用户点「部署」；FC ensureAppSchema + ensureFunction 成功
   ▼
awaiting_build
   │ 桌面踢 daemon /v1/apps/build；daemon 开始构建
   ▼
building            （daemon 构建 + 打包 + 上传 OSS）
   │ 桌面拿到 ossObjectName，调 FC /deploy/finalize
   ▼
deploying           （FC updateFunctionCode + 迁移 + ensureHttpTrigger）
   │ 成功
   ▼
live                （fc_endpoint 可访问）

任一步失败 → deploy_error（写 provision_error），点「部署」可重试。
```

- 与 `provision_status` 正交：必须 `provision_status='ready'` 才允许进入部署。
- 幂等：`awaiting_build`/`deploy_error`/`live` 任意态点「部署」都安全重跑。

### 部署时序（端到端）

```
桌面「部署」
  │
  ├─(1) POST /v1/apps/{id}/deploy ───────────► FC（控制面）
  │        ensureAppSchema(teamclu_apps)      （幂等）
  │        ensureFunction tc-app-{appId}       （注入 DATABASE_URL env）
  │        fc_status=awaiting_build
  │
  ├─(2) POST daemon /v1/apps/build（本地）───► daemon（构建器）
  │        pnpm install && pnpm build
  │        zip 产物 + bootstrap → OSS apps/{appId}/deploy-{ts}.zip
  │        → { ossObjectName }
  │
  └─(3) POST /v1/apps/{id}/deploy/finalize {ossObjectName} ─► FC
           updateFunctionCodeFromOss
           ensureHttpTrigger → fc_endpoint
           fc_status=live
           （app 业务迁移在函数冷启动时对自己的 schema 自执行，见 §5）
```

---

## 5. 错误处理、幂等与安全

### 幂等与重试
- `ensureAppSchema`：`CREATE ... IF NOT EXISTS`，角色缺失才建、密码缺失才轮换；
  重部署不重复建。
- `ensureFunction`：check-then-create；`updateFunctionCode` 天然幂等（后写胜）。
- 每步落 `fc_status`；失败置 `deploy_error` + `provision_error`（UI surface，不
  静默吞）。重试 = 再点「部署」。

### 安全边界
- Postgres admin（`APPS_DB_ADMIN_URL`）与 Aliyun AK/SK **只在 FC env**，不下发
  daemon/客户端。
- per-app DB 角色受限：仅 `GRANT` 自己 schema、`search_path` 固定，无法访问其它
  schema 或 `supabase_db`。app 的 `DATABASE_URL`（含角色密码）**只在 FC 函数
  env**，不入库、不进产物（镜像 managed-git PAT 处理）。
- 部署端点 creator-gated（`apps_update_if_creator` 限制写 + 路由再校验）。
- OSS 产物路径按 `apps/{appId}/` 命名空间隔离；zip 内无任何密钥。

### app 迁移的执行者
- 默认：**app 自带迁移在冷启动时对自己的 schema 执行**（角色拥有该 schema，可
  建表）。FC `finalize` 不直接代跑业务迁移，避免在控制面持有 app 业务知识。
- 备选（计划阶段再定）：`finalize` 触发一次性迁移调用。先按「app 自迁移」实现。

---

## 6. 测试

- **FC 单元**：
  - `app-postgres`：schema/role SQL 正确性 + 幂等重跑（对一次性 throwaway DB）。
  - `apps-deploy` 路由：mock `@alicloud` 客户端，覆盖 `deploy → awaiting_build`、
    `finalize → live`，以及每条失败路径 → `deploy_error`。
  - repository-contract：新部署字段/流转在 pg-repo 与 supabase-repo 双实现。
- **daemon**：`cargo test --bin amuxd` 覆盖 `app_build`（构建调用 + 打包 + OSS
  对象命名；mock OSS）。
- **迁移回归**：RLS 递归（已在 `ad48f38c` 修，见 §2.2）—— 加一条回归测试，测
  「真实团队成员能 `SELECT` team 可见 + 被授权的 app 而 **不** 触发 `42P17`」，
  锁住 helper 行为，防后续 apps RLS 改动重新引入环。
- **模板**：`templates/tanstack-postgres/` 的 smoke build（CI `pnpm build` 产出
  预期 bundle 布局）。
- **桌面**：store/列表行 vitest —— 「部署」按钮 gating + 状态流转 + live 链接渲染。
- **i18n**：新增键过 i18n-parity 守卫。

---

## 7. 需尽早 spike 的风险（计划阶段前置验证）

1. **TanStack Start 跑在 Aliyun FC nodejs20 custom runtime + HTTP 触发**
   （bootstrap 形状、端口绑定、冷启动）—— 先用最小函数验证再接全模板。
2. **`@alicloud/fc20230330` API 面**：create / update-from-OSS / 读触发 URL 的
   确切调用与返回形状。

（原「RLS 递归」spike 已不需要 —— 已在 `ad48f38c` 修复并核实，见 §2.2。）

---

## 8. 明确不做（第二期 Out of Scope）

- per-app **自定义域名**（`*.apps.ucar.cc`）—— 先用 FC 默认 HTTP 触发 URL。
- push 自动部署 / CI 流水线 —— 仅显式「部署」按钮。
- per-repo scoped git token —— 仍用共享组织 PAT（沿用 phase-2a）。
- iOS / expo 端的部署 UI。
- app 类型扩展（仍仅 `fullstack_tanstack_postgres`）。
- 部署回滚 / 多版本 / 蓝绿 —— 后写胜，最简。
- app 删除时的 FC 函数 / schema 回收（可留最小标记，按需另立）。

---

## 9. 交付里程碑（实现拆解，便于 subagent-driven 执行）

> 设计覆盖完整流水线；实现按里程碑推进，每个里程碑可独立验证、每任务双审。

- **M0 — spike**：FC custom runtime 跑最小 TanStack server + `@alicloud` 建/更新
  函数。两个风险点各出一个可工作的最小验证（RLS 递归已在 `ad48f38c` 解决）。
- **M1 — Postgres provisioning**：`app-postgres.ts` + `APPS_DB_ADMIN_URL` + 新库
  `teamclu_apps` + 角色隔离测试 + RLS 递归回归测试（§6）。
- **M2 — FC 函数 provisioning**：`app-fc-function.ts` + `POST /deploy`（到
  `awaiting_build`）+ 契约/双 repo + OpenAPI。
- **M3 — 构建与交接**：模板可部署化 + daemon `app_build` + `POST /apps/build` +
  OSS 产物。
- **M4 — finalize 与上线**：`POST /deploy/finalize` + 触发 URL 回填 + app 迁移 +
  `fc_status=live`。
- **M5 — 桌面 UI**：部署按钮 + 状态徽章 + live 链接 + 编排 + 重试。
