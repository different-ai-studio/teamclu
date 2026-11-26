# App 平台 P3 — 收掉旧模型（草案）

父 spec：`2026-11-24-app-platform-infra-decoupling-design.md` §8 P3。
前置：P2（`2026-11-25-app-platform-p2-de-team.md`，PR #2016）。P2 结束时，平台读写的都是 org + 账号模型，
但写入的源头仍是旧列，由 P2.1 的触发器投影到新表。

**状态：2026-11-26 七个问题全部按推荐拍板（§5）。P3.5 不做。**

## 0. 目标与约束

**目标**：新表成为唯一的源头，旧列、旧表、旧函数和投影触发器全部删除；forge 列搬到 TeamClu 侧（原 P1.5）。

**约束**：
- `/v1` 响应字段不变。iOS 把 `App.teamId` 解码为非可选 `String`，缺字段会整个解析失败；桌面、Expo、
  `crates/teamclu-apps`、desktop introspect 都读 `teamId` / `visibility` / `workspaceId` / `createdByActorId` /
  `relationship` / `invitedByActorId`。这些字段改由 TeamClu 层从 `app_links` 和 `app_grants` 推导。
- 删列是单向的，单独成步、单独上线，前面每一步都能回滚到上一版 FC。

**退出标准**：
1. `amux.apps` 上没有 `team_id` / `created_by_actor_id` / `workspace_id` / `visibility`；`amux.app_member_access`、
   `app_env_vars.updated_by_member_id`、`app_cron_jobs.created_by_member_id` 不存在。
2. 平台表（apps 及附属表、`app_grants`、`app_delegations`）没有指向 `teams` / `actors` / `members` / `workspaces` / `agents`
   的外键；只有 `app_links`（TeamClu 表）指向它们。
3. `tenant-boundary.test.ts` 的 PENDING 为空。

## 1. 现状（2026-11-26，`0eb11df96`）

### 1.1 旧列的读写方

| 旧项 | 写入 | 读取 | 数据库里还引用它的对象 |
|---|---|---|---|
| `apps.team_id` | TeamClu `tenant.ts` 建 app | TeamClu：列表过滤、`relationship`、auth-info、access 页、git 凭证、Gitea 同步；会话的 appContext；apps 登录页显示团队名 | FK→teams CASCADE；`apps_team_slug_uniq`；`apps_insert_if_team_member`；`trg_apps_project`；`app_inherited_agents`、`caller_has_app_grant`、`app_member_access_same_team`；**其他功能**：`team_leaderboard_contributions`、`upgrade_account_to_org`、`guard_team_org_move`（teams 上的触发器，十几个 pgTAP 会经它间接碰到 apps） |
| `apps.created_by_actor_id` | TeamClu 建 app | `relationship=owner`、`createdByActorId`、git 访问 isCreator、Gitea 同步 | FK→actors RESTRICT；INSERT 策略；`apps_creator_user` / `apps_project` / `actors_project_app_identity` 触发器；排行榜函数 |
| `apps.workspace_id` | TeamClu 建 app（1:1 workspace） | 删 app 时归档 workspace；`workspaceId` | FK→workspaces；`apps_workspace_uniq`；`trg_apps_project` |
| `apps.visibility` | TeamClu 建 app、PATCH | `relationship=team`、appContext、git 只读凭证、Gitea 读组 | CHECK；`trg_apps_project`（投影成 org 授权）。已无策略读它 |
| `app_member_access` | TeamClu access 页 | access 页、`invitedByActorId`、git 访问、Gitea 同步、`app_inherited_agents` | 两条策略；三个触发器；`actor_has_app_access`、`app_project_member_grants`；`app_grants.legacy_member_id` FK |
| `*_by_member_id`（env / cron） | 平台写 null（防触发器回填） | 无 | FK→**members**；`trg_app_operator_user` |
| `git_remote_url` / `git_auth_kind` / `git_commit_sha` | 平台：建 app、provisionRepo、finalize、外部凭证 | 平台 forge 守卫和删除；TeamClu forge、Gitea 同步、deploy key 过期；`mapApp` | 无（普通列） |

另外两点：
- `createApp` 从来没有直接写 `created_by_user_id`，靠 BEFORE 触发器从 actor 推出。P3 要由平台直接写。
- `supabase-repo/shared.ts` 的 `APP_COLUMNS` / `mapApp` / `appRelationshipFor` 被平台 `apps.ts` 引用，
  所以平台的每次读取都经 TeamClu 代码带出旧列。要拆成平台列和 TeamClu 装饰两部分。

### 1.2 平台函数仍连 TeamClu 表

`caller_app_access` / `caller_apps` / `caller_org_ids` 用 `actors.team_id → teams.oid` 判断「调用方是不是 org 成员」。
org 成员关系现在只能这么算（`org_roles_users` 只有角色，不覆盖全部成员），P3 不改，只把它收进一个函数
`amux.caller_org_ids()`，其他函数都调它，留一个接缝。

### 1.3 暴露 schema 的配置

- self-host：`.env` 的 `PGRST_DB_SCHEMAS=public,storage,graphql_public,amux`。
- belayo：共享库里 `authenticator` 角色的 `pgrst.db_schemas = public, amux, storage, graphql_public`，这个库和 Betly 共用。

## 2. 步骤（草案）

| 步 | 内容 | 数据库 | 可回滚 |
|---|---|---|---|
| P3.1 读切换 | TeamClu 层剩下的旧读取全部改读新表：列表经 `app_links`；`relationship` / `invitedByActorId` / access 页经 `app_grants` + actor↔账号映射；git 访问和 Gitea 同步改问 `caller_app_access` 或 `app_grants`；agent 继承改读 `app_delegations`；`visibility` 由 org 授权推导。`APP_COLUMNS` 拆开 | 无（或只加函数） | ✅ 写入仍是旧列 + 触发器 |
| P3.2 写两边 | FC 写旧列之后直接写新表：建 app 写 `created_by_user_id`、`app_links`、org 授权；PATCH visibility 同步 org 授权；access 页写 `app_grants`。触发器保留，新表这一步在 P3.4 前多为空操作 | 无 | ✅（旧列照写） |
| P3.3 forge 表（原 P1.5） | `amux.app_forge_repos(app_id, remote_url, auth_kind)` 归 TeamClu；`git_commit_sha` → 通用 `apps.deployed_revision`。读新列、旧列回填，先双写 | 新表 + 回填 + 新列 | ✅ |
| P3.4 删旧（单向） | 删旧列、`app_member_access`、`legacy_member_id`、正反两套触发器、旧函数；`apps_team_slug_uniq` 随列删；改写排行榜、`upgrade_account_to_org`、`guard_team_org_move` 改读 `app_links`；pgTAP 全部改为新形态插入；删 forge 旧列 | 删除 | ❌ |
| ~~P3.5 独立 schema~~ | 不做（Q5）：表留在 `amux`，靠外键规则 + 边界测试守边界；单独起库留到 P4 | — | — |

### 2.1 P3.1 拆分

写入仍是旧列 + P2.1 触发器；P3.1 只换读取。完成后 FC 里旧列只剩写入方（建 app、PATCH visibility、access 页增删），P3.2 再换。

- **P3.1a 测试假库投影**：`test/fixtures/apps-repository.ts` 像 P2.1 触发器一样，从旧表实时推导 `app_links` / `app_grants` / `app_delegations`。
- **P3.1b 展示拆分**：平台的 `mapApp` / 选列只含平台列；`teamId` / `visibility` / `workspaceId` / `createdByActorId` / `relationship` / `invitedByActorId` 全部由 `AppTenantHooks.decorate` 给出，覆盖每个返回 App 的接口（不只是列表和详情）。列表按团队过滤改为内嵌 `app_links!inner(team_id)`，`app_links` 加 `authenticated` 的 SELECT 策略：`app_id in (select app_id from caller_apps())`。
- **P3.1c TeamClu repo**：viewer / access 页 / 成员判断 / access manager / git 凭证改读 `app_links` + `app_grants`（账号 → 该团队的 actor）+ `app_delegations`。
- **P3.1d forge**：`app-git-access.ts`、`gitea/sync.ts` 改读新模型。
- **P3.1e 其他读者**：会话 appContext、apps 登录页、vanity、`updateApp` 判断 visibility 是否变化。
- **P3.1f 守卫**：测试扫描 `src/`，旧列名只能出现在登记过的写入点。

### 2.2 P3.1 实施记录（2026-11-26）

- **P3.1a/b**（`2ec19aefc`）：`AppTenantHooks` 加 `fields` / `listEmbed`；平台所有返回 App 的接口都经 `presentApps`。迁移 `20261127100000` 给 `app_links`、`app_grants` 加 `authenticated` 的 SELECT 策略（看得见 app 才读得到它的 link；授权行：自己的、看得见的 app 上的 org 授权、创建者看全部），TeamClu 字段全部用调用方 token 读，列表不再需要 service role。
- **P3.1c–e**：新模块 `teamclu-apps/team-app-access.ts`，按 actor 读出某个 app 在其团队里的创建者、授权、继承的 agent 和是否团队可见，规则与 `app_inherited_agents` 相同。access 页、git 访问判定、Gitea 同步、git 凭证、成员判断、apps 登录页的团队名都改用它或 `app_links`。`callAgentInheritance` 删除；vanity / gate 里没人用的 `teamId` 删除。
- **行为变化**：没有账号的 agent 持有的旧授权不再出现在 access 页（授权按账号存，这种行从未投影；新授权本来就被 `agent_not_connected` 拒绝；belayo 上 0 行）。
- **P3.1f 守卫**：`test/app-platform/legacy-reads.test.ts` 扫描 `src/`：`apps` 的查询链不许出现四个旧列；`app_member_access` 只许出现在 access 页的三处写入；不许调用 actor 版继承函数。放一个读 `apps.team_id` 的探针文件，守卫会报错。

### 2.3 P3.2 实施记录（2026-11-26）

- 平台 `app-platform/grants.ts`：`setUserGrant`（先 update，没有再 insert，23505 视为已存在——唯一索引是部分索引，PostgREST 的 upsert 用不上）、`removeUserGrant`、`setOrgGrant`、`readUserGrantLevel`。
- 建 app：平台直接写 `created_by_user_id`（P2.1 触发器在 INSERT 时保留显式值）；TeamClu `created` upsert `app_links`（workspace 取自 `writeColumns` 刚建的，不能用返回行——平台选列里已经没有 `workspace_id`，否则会把投影写成 null）并为团队可见的 app 写 org 授权。
- `AppTenantHooks.updated(row, patch)`：PATCH 改 visibility 后 TeamClu 同步 org 授权。
- access 页：授权 / 撤销同时写 `app_grants`（按账号）；写之前读原级别也改读 `app_grants`。`legacy-reads` 守卫的 `app_member_access` 计数 3 → 2。
- 测试：FC `dual-write.test.ts`（4 条）；pgTAP `app_platform_p3_dual_write.test.sql`（10 条）在真实触发器下按 FC 的顺序写，确认每一步都落在投影上、不报错不覆盖。

### 2.4 P3.3 实施记录（2026-11-26）

- 迁移 `20261127200000`：
  - 新表 `amux.app_forge_repos(app_id, remote_url, auth_kind)`，归 TeamClu forge。没有照草案加 `kind` 列：`auth_kind` 已经能区分 Gitea 托管和导入，再加一列只是重复。belayo 上还有 5 行旧值 `pat`，原样搬过来。
  - `apps.deployed_revision` 替代 `git_commit_sha`，含义不变，是客户端报上来的上次部署版本，平台不解释它。
  - 在 P3.4 删旧列之前，两个触发器把旧列投影到新表和新列，P3.3 之前的 FC 镜像照样能用；两者都已回填一遍。
  - 读权限：看得见 app 就看得见它的仓库，和原来的 `apps.git_remote_url` 一样；写只走 service role。
- forge 钩子：
  - `AppLifecycleHooks` 新增 `repos(client, ids)` 和 `recordImportedRepo`。
  - `provisionRepo` 和外部凭证的存、清，都由 forge 自己写记录。
  - 平台读 app 时用 `withRepos` 把 forge 记录附到行上，再交给 forge 钩子和 `mapApp`。`APP_COLUMNS` 不再含三个 git 列。
- TeamClu 一侧：Gitea 同步、deploy key 过期清扫、git 凭证、撤销 deploy key 都改读 `app_forge_repos`。`noTeamCluForge` 也记录导入的仓库；平台的 `noForge` 不记录，所以这种部署下导入 app 的 `gitRemoteUrl` 为 null。
- 双写：建 app（导入、Gitea 建仓）、存凭证、清凭证、finalize 都是旧列和新位置一起写。`legacy-reads` 守卫把三个 git 列也纳入检查，并加了一条：`APP_COLUMNS` 里不许出现旧列。
- 测试：pgTAP `app_platform_p3_forge.test.sql`（16 条）覆盖投影、显式值优先、读权限；FC `forge-dual-write.test.ts`（4 条）和 finalize 一条。

## 3. 回滚

- P3.1：换回 P2 镜像即可。
- P3.2：换回 P3.1 镜像；反向触发器保证旧列仍是最新的。
- P3.4：只能向前修。上线前对涉及的表做一次逻辑备份（`pg_dump -t`），保留 30 天。

## 4. 验证

- 每步：pgTAP（从零重建）+ FC 全量 + self-host 回滚演练（新旧结果逐对比较）+ self-host E2E（自带 / app 35 / 容器 20）。
- P3.1、P3.2 额外比对：对每个 (用户, app)，新旧代码路径给出的 `/v1/apps` 响应字段一致（`teamId`、`visibility`、`relationship`、`invitedByActorId`、access 页行）。

## 5. 决定（2026-11-26，全部按推荐）

| # | 问题 | 决定 |
|---|---|---|
| Q1 | `/v1` 字段 | 保持不变，`teamId` / `visibility` / `workspaceId` / `createdByActorId` / `relationship` / `invitedByActorId` 由 TeamClu 层从 `app_links` / `app_grants` 推导；客户端不改 |
| Q2 | 写切换能否回滚 | 能。~~反向触发器~~ → 11/26 改为**同时写两边**：P3.2 起 FC 先写旧列（P2.1 正向触发器照常投影），再直接写新表；回滚到 P3.1 镜像时旧列和投影仍一致。P3.4 删旧时去掉旧列写入和触发器 |
| Q3 | 删旧的节奏 | P3.4 单独一个 PR；P2 和 P3.1–P3.3 在 belayo 跑满一周再合。开发和整体测试照常一起做 |
| Q4 | access 接口 | `/v1/apps/:id/access` 仍按 actor id；存成 `app_grants`（账号），TeamClu 层换算；agent 的授权 = 它账号的授权；git 访问、Gitea 同步改问新模型，继承改读 `app_delegations` |
| Q5 | 独立 schema | 不搬（P3.5 取消）。表留在 `amux`，边界靠「平台表不指向 TeamClu 表」+ `tenant-boundary.test.ts`；单独起库留到 P4 |
| Q6 | 别的功能读 `apps.team_id` | 排行榜、`upgrade_account_to_org`、`guard_team_org_move` 在 P3.4 改读 `app_links.team_id` |
| Q7 | org 成员判定 | 判定方式不变，收进 `amux.caller_org_ids()`，其他平台函数都调它 |
