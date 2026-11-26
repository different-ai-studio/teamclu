# App 平台 P3 — 收掉旧模型（草案）

父 spec：`2026-11-24-app-platform-infra-decoupling-design.md` §8 P3。
前置：P2（`2026-11-25-app-platform-p2-de-team.md`，PR #2016）。P2 结束时，平台读写的都是 org + 账号模型，
但写入的源头仍是旧列，由 P2.1 的触发器投影到新表。

**状态：草案，§5 的问题待拍板。**

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
| P3.2 写切换 | FC 直接写新表：建 app 写 `created_by_user_id`、`app_links`、org 授权；access 页写 `app_grants`；agent 委托由 agents 触发器维护（保留）。旧列改为可空、不再写；**反向触发器**把新表写回旧列，让 P3.1 镜像回滚后仍然正确 | 改可空、反向触发器、换 INSERT 策略 | ✅（靠反向触发器） |
| P3.3 forge 表（原 P1.5） | `amux.app_forge_repos(app_id, kind, remote_url, auth_kind)` 归 TeamClu；`git_commit_sha` → 通用 `apps.deployed_revision`。读新列、旧列回填，先双写 | 新表 + 回填 + 新列 | ✅ |
| P3.4 删旧（单向） | 删旧列、`app_member_access`、`legacy_member_id`、正反两套触发器、旧函数；`apps_team_slug_uniq` 随列删；改写排行榜、`upgrade_account_to_org`、`guard_team_org_move` 改读 `app_links`；pgTAP 全部改为新形态插入；删 forge 旧列 | 删除 | ❌ |
| P3.5 独立 schema | 平台表搬到 `app_platform` | 见 Q5 | — |

## 3. 回滚

- P3.1：换回 P2 镜像即可。
- P3.2：换回 P3.1 镜像；反向触发器保证旧列仍是最新的。
- P3.4：只能向前修。上线前对涉及的表做一次逻辑备份（`pg_dump -t`），保留 30 天。

## 4. 验证

- 每步：pgTAP（从零重建）+ FC 全量 + self-host 回滚演练（新旧结果逐对比较）+ self-host E2E（自带 / app 35 / 容器 20）。
- P3.1、P3.2 额外比对：对每个 (用户, app)，新旧代码路径给出的 `/v1/apps` 响应字段一致（`teamId`、`visibility`、`relationship`、`invitedByActorId`、access 页行）。

## 5. 待拍板

见会话中的问题列表；拍板后补到这里。
