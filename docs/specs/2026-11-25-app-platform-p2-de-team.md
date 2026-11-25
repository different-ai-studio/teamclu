# App 平台 P2 — 去 team 化（实施方案，草案）

父 spec：`2026-11-24-app-platform-infra-decoupling-design.md`，见 §3、§5 和 §8 的 P2 行。
前置：P1（Gitea 出平台）完成，代码在 `task/app-platform-p1-1`。
本文先清点现状，再列出拆分步骤和待拍板的问题。§6 的问题定下来之前不写代码。

## 0. 目标与约束

**目标**：平台只认 `org_id`（租户）和 `auth.users.id`（主体）。team、actor、member、workspace、session 这些概念
全部归 TeamClu 层所有，TeamClu 通过新表 `amux.app_links` 与 app 关联。

**约束**：

- **老客户端不能坏。** 清点下来，下面这些字段和参数仍有客户端硬依赖，详见 §1.4。P2 期间 API 照常输出它们，
  值改由 TeamClu 层从 `app_links` 和 `actors` 换算出来：
  - App 的 `teamId`：iOS 解码时是必填；daemon 拿它拼本地 checkout 路径 `teams/<teamId>/apps/<appId>`。
  - App 的 `workspaceId`：app 会话入座要用。
  - access 行的 `memberId`，即 actor id：桌面端访问页和 introspect 都用它。
  - `AppAuthInfo.teamId`：桌面 introspect 的 serde 是必填。
  - 收件箱消息 `app.access` 里的 `team_id`：桌面端缺了它就直接丢弃这条消息。
  - `GET /v1/apps?teamId=`、`POST /v1/apps { teamId }`：daemon、桌面、iOS、Expo 都在用。
- **先扩、后切、再收（expand → switch → contract）。** 加新表、新列，回填，然后双写，让 FC 回滚始终安全。
  删旧列、旧策略这一步是单向的，单独放在最后（§3 P2.5），是否推迟到 P3 见 §6 Q7。
- 每一步都要在 self-host 跑迁移和 pgTAP，并跑 E2E。迁移还要在 belayo 手工执行。

**退出标准**（父 spec §8）：
1. 平台目录里 grep 不到 `team` / `actor` / `member` / `session` / `workspace`（落地方式和 P1 一样，加一条边界测试）。
2. 老客户端按 teamId 调用，经 `app_links` 仍然可用。

## 1. 现状（2026-11-25，main + P1）

### 1.1 数据库

| 对象 | 现状 | 和 team / actor 的关系 |
|---|---|---|
| `amux.apps.team_id` | NOT NULL → `teams` ON DELETE CASCADE | 删除团队时连带删除 app |
| `amux.apps.created_by_actor_id` | NOT NULL → `actors` ON DELETE **RESTRICT** | `remove_team_actor` 靠这个外键报 `agent_delete_blocked_by_apps`；排行榜按它统计 |
| `amux.apps.workspace_id` | → `workspaces` SET NULL，`UNIQUE` | 一个工作区对应一个 app |
| `amux.apps.visibility` | `personal`（默认）\| `team` | 只用在 `apps_select_if_visible` 里 |
| `amux.apps.org_id` | **已经是 NOT NULL 外键** → `public.orgs`（NO ACTION） | 已经是租户；`upgrade_account_to_org` 会维护它 |
| `apps_team_slug_uniq` | `UNIQUE (team_id, slug)` | slug 在团队内唯一 |
| `app_member_access` | `member_id` → `actors` CASCADE；`granted_by_member_id` → `actors`；`read\|write\|admin` | 触发器 `app_member_access_same_team` 要求被授权人与 app 同团队 |
| `app_cron_jobs.created_by_member_id`、`app_env_vars.updated_by_member_id` | → **`amux.members`**（不是 actors） | 写入了，但 API 从不返回 |
| `app_secrets`、`app_lifecycle_operations`、`app_cron_runs` | 没有身份列 | — |
| `amux.sessions.app_id` | → apps SET NULL | 会话列表 RPC 靠它把会话归为 app 类 |

RLS 和函数：

- `apps_insert_if_team_member` / `apps_select_if_visible` / `apps_update_if_creator`：全部基于
  `is_team_member` 和 `current_actor_id_for_team`。apps 表**没有 DELETE 策略**，删除都走 service role。
- `actor_has_app_access`、`caller_has_app_grant`：按 actor 判断。
- agent 继承：`app_inherited_agents` / `agent_inherited_app_level`。**SQL 里没有封顶，创建者的 agent 拿到的是 admin**；
  只有「管授权」和「删 app」这两项由 Cloud API 拦下。
- `amux.is_org_member(org)` 已经存在，实现是「属于该 org 下任一团队」。平台可以直接用，判定规则留在 TeamClu。
- `guard_team_org_move`、`upgrade_account_to_org`、`team_leaderboard_contributions` 都按 `apps.team_id` 或 `created_by_actor_id` 查询。

隐患（顺带记下）：
- 删除团队时，`actors` 和 `apps` 都会被级联删除，而 `created_by_actor_id` 是 RESTRICT，结果取决于级联顺序。
- `apps.team_id` 不受 `reject_team_reassignment` 保护。
- org 回收流程靠「删团队 → 级联删 app」走通。一旦 app 不再随团队删除，`apps.org_id`（NO ACTION）就会挡住删除 org。

### 1.2 FC

所有带权限检查的方法都会先 `select team_id, created_by_actor_id`，再调用 `resolveAppCallerPermissionForApp`，大约 17 处。
后者的判定顺序是：调用方在该团队的 actor → 是否创建者 → `app_member_access` 的授权 → agent 继承。
各点的具体位置见附录 A。

已经按 org 走的部分：
- 登录墙和网关准入。`apps-login-service.ts:151` 还读 `teams.name`，但只用作同意页的说明文字。
- 部署、数据浏览器定位数据库。
- Gitea org 命名。

两处不一致：
- `updateApp` 用 `teams.oid` 校验登录墙的角色码，而不是 `apps.org_id`。
- `getAppAuthInfo` 要求调用方是该团队成员。

### 1.3 HTTP

- 带 team 的入参：`GET /v1/apps?teamId=`（必填）、`POST /v1/apps { teamId, visibility, grantActorIds }`。
- 带 team / actor 的出参：
  - App 上的 `teamId`（必填）、`createdByActorId`、`relationship`（`owner`/`invited`/`team`）、`invitedByActorId`、`visibility`（必填）、`workspaceId`；
  - `AppAuthInfo.teamId`；
  - access 行上的 `memberId` / `grantedByMemberId` / `actorType` / `inheritedFrom`；
  - `/v1/git/access` 返回的 `actorType` / `actorName`。
- 路径参数 `PUT|DELETE /v1/apps/{id}/access/{memberId}` 里的 `memberId` 是 actor id。

### 1.4 客户端依赖（P2 期间不能断）

| 客户端 | 硬依赖 |
|---|---|
| daemon / `crates/teamclu-apps` | App 的 `teamId`（拼 checkout 路径、seed/clone/bind/deploy/status）、`workspaceId`（`bind_workspace_row`）；`?teamId=` 列表 |
| 桌面端 | `teamId`、`workspaceId`（入座）、`createdByActorId`、`visibility`；access 行的 `memberId`；`app.access` 消息里的 `team_id` |
| iOS | `CloudTeamApp.teamId`、`CloudTeamAppSession.teamId` 解码时必填 |
| 桌面 introspect | `AppAuthInfo.team_id` 在 serde 里必填；access 用 actor id |
| Expo | 所有字段都可选，能容忍字段缺失 |

没有调用方的：`GET /v1/apps/:id/membership`、access 行的 `grantedByMemberId` / `connected`。

## 2. 目标结构

```
amux.apps                      平台：org_id、created_by_user_id、……（去掉 team_id / created_by_actor_id / workspace_id / visibility）
amux.app_grants                平台：(app_id, principal_user_id | principal_org_id, level, granted_by_user_id)
amux.app_delegations           平台：(delegate_user_id → principal_user_id)，按父 spec §5 封顶 write
amux.app_links                 TeamClu：(app_id PK, team_id, workspace_id, created_by_actor_id)
```

- **`app_links` 把创建者 actor 一起带过去。** `agent_delete_blocked_by_apps`、排行榜、`createdByActorId` 字段都依赖它，
  外键 RESTRICT 也跟着搬到 `app_links`，这样行为不变。
- **API 兼容层放在 TeamClu。** 平台返回的 app 不带 team 字段，由 TeamClu 层的 `decorate` 从 `app_links` 补上
  `teamId` / `workspaceId` / `createdByActorId`。思路和 P1 的 forge 钩子一样，可以复用 `AppLifecycleHooks.decorate`，
  或者另起一组 `AppTenantHooks`。
- **`visibility` 是派生出来的。** app 有 org read 授权就输出 `team`，否则输出 `personal`。写入 `visibility=team`
  等于添加 org read 授权，写入 `personal` 等于删除它。
- **access 接口的 `memberId`。** 输入时，TeamClu 层把 actor id 换成 `actors.user_id` 再交给平台；输出时，
  再把 user id 换回该团队里的 actor id。

## 3. 步骤（草案）

| 步 | 内容 | 迁移 | 可回滚 |
|---|---|---|---|
| P2.1 扩表 | 新增 `app_links`、`app_grants`、`app_delegations`、`apps.created_by_user_id`、`*_by_user_id` 操作人列，全部从现有数据回填；FC **双写**（新旧两边都写），读取仍走旧路径 | 只加不删 | ✅ |
| P2.2 FC 切读 | 权限判定改为：创建者 user → user 授权 → org 授权 → 委托；列表改为按 org，`teamId` 经 `app_links` 过滤；TeamClu 兼容层补字段 | 无 | ✅（旧数据一直在双写） |
| P2.3 RLS 切换 | apps 及其附属表的策略改为 `is_org_member(org_id)` 加授权；新增 `app_has_access(app, uid)` | 换策略，旧策略保留到 P2.5 | ✅（可以把策略换回去） |
| P2.4 平台边界 | 平台目录 grep 不到 team / actor / …，边界测试清零 | 无 | ✅ |
| P2.5 收表 | 删除 `apps.team_id` / `created_by_actor_id` / `workspace_id` / `visibility`、`app_member_access`、旧函数和触发器 | **删列** | ❌ 单向 |

回填规则（P2.1）：
- `created_by_user_id` 取 `actors.user_id`。如果创建者是没有连上账号的 agent（`user_id` 为空），就取它主人的 user id，
  见 §6 Q5。
- `app_grants`：
  - `app_member_access` 的 actor 换成对应的 `user_id`（`user_id` 为空的行跳过并记录下来）；
  - `visibility='team'` 的 app 补一行 org read。
- `app_delegations`：每个 `active` 的 agent，委托人是它主人那个 member actor 的 user，代理人是 agent 自己的 user。

## 4. 验证

- 每一步：FC 全量测试 + `tsc`；P2.1 / P2.3 加 pgTAP（新表、策略、回填结果）。
- 每步合并前在 self-host 跑 E2E：现有 35 项、容器 16+ 项，另加授权矩阵：
  - 成员 / agent / 委托 / org 授权 × 读 / 写 / 部署 / 管授权；
  - 用老 `teamId` 参数列表、建 app；
  - iOS 和桌面 introspect 能正常解码返回结果。
- 回填前后各取一次全部 app 的权限快照，逐行 diff（只有 §6 Q1 那条封顶规则允许产生差异）。

## 5. 风险

- 授权模型一换，所有 app 的可见性和权限都会变。必须靠回填后的快照 diff 兜底。
- belayo 的迁移是手工执行的；P2.1 和 P2.3 都要在 belayo 上执行，还要和 FC 镜像发布的顺序协调好。
- 会话、知识库等 TeamClu 功能里用到 `apps.team_id` 的查询（会话列表 RPC、app 上下文快照）要改成经 `app_links`。

## 6. 需要拍板

1. **Delegation 封顶 write，agent 就不能部署主人的 app 了。** 父 spec §5 写的是「已确认接受」，但现状是创建者的 agent
   拿到 admin、可以部署，「成员建 app、agent 部署」是主要流程（E2E 的容器用例就是这么走的）。封顶之后，这条流程需要
   成员再额外授权 admin。是否仍按封顶执行？
2. **slug 唯一性。** 现在是团队内唯一。去 team 之后有三个选项：改成 org 内唯一（同一个 org 下跨团队重名的 slug 要先处理）、
   改成 `app_links (team_id, slug)` 唯一（留在 TeamClu）、或者干脆不再唯一（`app_code` 本来就是全局 id）。
3. **删除团队时 app 怎么办。** 现在会被级联删除。去 team 之后，是 app 保留下来、只删 `app_links`（app 归 org 所有），
   还是照旧随团队删除（经 `app_links` 级联）？如果保留，org 回收流程要改成显式删除 app。
4. **授权给 org 的级别。** 父 spec 规定 org 授权只能是 read / write。现有 `visibility=team` 回填成 org read，
   与现在「整个团队可读」相比，范围扩大到整个 org，这一点父 spec 已接受。新建 app 默认只有创建者可见，与现状一致。
5. **创建者是没连账号的 agent 时**，`created_by_user_id` 回填成谁？候选：它的主人，或者留空（意味着这个 app 没有 admin，
   只能由 org 管理员处理）。
6. **兼容层放在哪。** 复用 `AppLifecycleHooks`，让它同时承担 forge 和 tenant 两类钩子；还是新建一组 `AppTenantHooks`？
   后者更清楚，P3 拆 schema 时也更好切。
7. **P2.5 收表是放在 P2 里做，还是和 P1.5 一样推迟到 P3？** 理由相同：P3 本来就要搬表，而且只要旧列还在，FC 回滚就始终安全。

## 附录 A：FC 改动点（摘要）

| 方法 | 现状 | 改为 |
|---|---|---|
| `listApps` / `listAppsPage` | `.eq(team_id)` + `resolveAppViewer(teamId)` | 按 `org_id`；可选按 `app_links.team_id` 过滤 |
| `createApp` | 解析 actor，建 workspace，插入 `team_id` / `created_by_actor_id` / `visibility` | 平台插入 `org_id` / `created_by_user_id`；TeamClu 写 workspace 和 `app_links` |
| `resolveAppCallerPermissionForApp` 及约 17 个调用方 | actor → 创建者 → 授权 → 继承 | user → 创建者 → user/org 授权 → 委托 |
| `isAppCreator` ×4 | 比较 actor | `created_by_user_id === uid` |
| `setAppAccess` / `removeAppAccess` / `listAppAccess` | 以 actor 为键；`grantee_not_in_team` | 以 user/org 为键；TeamClu 层负责 actor ↔ user 换算 |
| `getAppAuthInfo` / `updateApp` 的角色码校验 | 用 `teams.oid`，要求团队成员 | 用 `apps.org_id`，要求 org 成员 |
| `putAppEnv` / `createAppCronJob` | `*_by_member_id` | `*_by_user_id` |
| `deleteApp` | 归档 workspace 和会话 | 归 TeamClu（删除钩子） |
| `scheduleAppAccessChanged` | 发给 member actor，消息带 `team_id` | 发给被授权的 user，`team_id` 取自 `app_links` |
| Gitea 同步（forge） | 团队可见对应 Gitea team | org 授权对应什么，跟着 Q4 定 |
