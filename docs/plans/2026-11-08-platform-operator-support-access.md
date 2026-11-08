# 平台运营进入任意 org 协助操作（支持模式）

## 背景

平台运营（超级租户）需要能切换到任意客户 org，在客户的团队里直接帮忙操作：看会话、
配置 agent、排查问题。现在的运营控制台（`/v1/admin/orgs`、`/v1/admin/teams`）只能用
service role 看列表、改额度，进不了客户的团队界面。

TeamClu 的 RLS 认的是「当前 org 里的 actor + `roles_users`」，不是 org 本身：
发消息要 `author_actor_id`，会话要参与者，`current_member_id` / `current_team_role`
都要求调用者在该团队里有 member actor。所以「进入」的本质是**让运营在目标 org 里有一个
能通过 RLS 的身份**。

## 决定（2026-11-08）

1. **谁是平台运营：`admin_type = 4` 且身份所在 org 是平台 org。** 与合作方 saas-mono 一致
   （`packages/shared/constants/admin.ts`：4 = `SYSTEM_ADMIN`，管理所有组织；合作方的
   api-key 逻辑同样要求 4 + 主 org）。belayo 上平台 org 是 Betly。
   平台 org 存在 `amux.deployment_settings('platform_org_id')`，不复用正在废除的
   `DEFAULT_ORG_ID`。限定 org 是为了防止别的 org 里误设的 4 直接拿到全平台权限。
2. **每个 org 共用一个支持账号**，不按运营各建。客户看到的始终是同一个「TeamClu 支持」。
3. **按会话区分运营。** 每次进入都用 `auth._mint_session` 新签一个会话（每次新建一行
   `auth.sessions`），在 `amux.support_grants` 里记下 `session_id → 运营`。
   多个运营同时进入互不影响；吊销按会话进行，不动共用账号。
4. **不需要客户同意，默认允许。**
5. **第一版权限给足：支持账号是该 org 的 owner**，不做禁止清单。
6. **对客户不隐藏，也不过滤。** 支持 actor 和普通成员一样出现在成员列表、@ 候选等处，
   只靠名字「TeamClu 支持」识别。合作方员工列表（`admin_type in (2,3,4)`）也先不过滤。

### 为什么不照搬合作方「4 直接放行」

saas-mono 后台切 org 是客户端存 org id + `X-Org-Id`，后端看到 4 就放行。TeamClu 的
RLS 依赖 actor，照搬等于给全库每一条策略和每一个 RPC 加「admin_type 4 例外」，
改动面大，以后新写的策略也容易漏。建一个真身份可以让整个 app 不改就能用。

### 为什么不冒充客户账号

签发某个成员的会话会把操作记到客户名下，没法审计，还会和客户争抢 refresh token 和 daemon。

### 为什么做不到对客户隐藏（记录，供以后参考）

- `amux.actors` 没有隐藏或归档字段；RLS `actors_select_if_team_member` 让团队成员能读到
  全部 actor，PostgREST 公网可达。
- `POST /v1/actors/by-ids`、`GET /v1/actors/{id}` 故意不过滤（历史消息要能解析作者）。
- 会话参与者、消息作者、MQTT actor 在线状态（retain）、本地缓存都会露出来。

## 设计

### 数据

```sql
-- 平台 org：amux.deployment_settings 新增键 'platform_org_id'

create table amux.support_grants (
  id               uuid primary key default gen_random_uuid(),
  session_id       uuid not null unique,      -- auth.sessions.id，也是 JWT 的 session_id claim
  operator_user_id uuid not null,             -- 运营在平台 org 的身份（admin_type 4）
  org_id           uuid not null,
  support_user_id  uuid not null,             -- 该 org 的共用支持账号
  team_id          uuid,                      -- 进入时选的团队，仅作记录
  reason           text not null,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  revoked_at       timestamptz
);
```

只有 service role 可读写；客户（org owner）能否查看访问记录留给后续。

### 数据库函数

- `amux.platform_org_id()`：读 deployment setting。
- `amux.is_platform_operator(p_user_id uuid default auth.uid())`：该身份
  `admin_type = 4 and org_id = amux.platform_org_id() and deleted_at is null`。
- `amux.ensure_support_identity(p_org_id uuid) returns uuid`（service role）：
  - 已有就返回；否则 INSERT `auth.users`（`support@<org id>.teamclu.support`，无密码，
    `raw_app_meta_data.org_id = p_org_id`）和 `public.users`（`admin_type 2`，
    `nickname = 'TeamClu 支持'`，`metadata.teamclu_support = true`）。
  - 写 `roles_users`：该 org 的 owner 角色（已有则跳过）。
  - 只用 INSERT，合作方触发器 `prevent_admin_type_change` 不拦。
  - 不写 `mobile`，不写 `email_users_links`，所以它不会通过 `person_identities`
    出现在任何人的身份选择器里。
- `amux.ensure_support_actor(p_team_id uuid)`（service role）：在团队里建或复用支持账号的
  member actor，`display_name = 'TeamClu 支持'`；团队成员关系的其他行（如有）一并补齐，
  具体写法照 `claim_team_invite` 的成员分支。
- `amux.support_grant_active() returns boolean`：调用者不是支持账号 → true；
  是支持账号 → JWT `session_id` 在 `support_grants` 里有一行未过期、未吊销。
  第一版只在少数入口调用（见下文「吊销」），不铺到全部策略。

### 进入

`POST /v1/admin/orgs/:orgId/support-sessions` `{ teamId, reason }`

1. 校验调用者 `is_platform_operator`，否则 403。
2. 校验 `teamId` 属于 `orgId`。
3. `ensure_support_identity(orgId)` → `ensure_support_actor(teamId)`。
4. `auth._mint_session(support_user_id)` 拿到 refresh token，换出 access token，
   取出 `session_id`。
5. 写 `support_grants`，`expires_at = now() + 4h`。
6. 返回 `{ refreshToken, accessToken, expiresAt, teamId }`。

客户端：
- 运营的团队选择器多一个「所有组织」入口（`usePlatformOperator()` 控制是否显示），
  搜 org → 选团队 → 填原因 → 调上面的接口。
- **进入前把运营自己的会话存在本地**，然后 `adoptSession` 换成支持会话，再走
  `enterTeam(teamId)`（`stores/current-team.ts`）。
- 顶部常驻横幅：「支持模式 · <org 名> · 剩余 hh:mm · 退出」。
- 支持模式下不绑定 daemon、不注册设备（运营本机的 amuxd 不能成为客户 org 的设备）。

### 退出

- 客户端调 `DELETE /v1/admin/support-sessions/current`（用支持会话调用）：FC 删除该
  `auth.sessions` 行、写 `revoked_at`。
- 客户端换回之前存下的运营会话，`enterTeam` 回运营原来的团队。
- **FC 不提供「用支持会话换回运营会话」的接口。** 否则拿到支持会话就等于拿到平台运营权限。

### 到期与吊销

- FC 定时任务：删除已过期 grant 对应的 `auth.sessions` 行，refresh token 随之失效。
- access token 最长还能用到自身过期（约 1 小时）。第一版接受这个窗口；如需立即生效，
  在 `current_member_id()` 一类入口函数里加 `support_grant_active()` 检查。
- 运营离职：把他的平台身份 `admin_type` 降下来，再吊销他名下所有未过期 grant。

### 审计

第一版只记 `support_grants`（谁、何时、进哪个 org/团队、原因、何时结束）。
具体写了什么，靠「这段时间里支持 actor 的写入」+ `session_id` 对应到人。

### FC 运营判定迁移

`isPlatformOperator()`（`services/fc/src/lib/platform-operators.ts`）改为
「`PLATFORM_OPERATOR_USER_IDS` 命中，或 `amux.is_platform_operator()` 为真」，
过一个版本后删掉环境变量。现有控制台接口（`/v1/admin/orgs`、`/v1/admin/teams`、额度）
一并改用新判定。self-host 上手工把自己的身份行设成 4，并配置 `platform_org_id`。

## 第一版不做

- 禁止清单（邀请成员、建 bot、改角色、删 org、充值等）。注意：bot 会继承邀请人的全部
  角色（20261102000000），支持账号建的 bot 会是 owner。
- 客户同意或审批、通知 org owner。
- 对客户隐藏或过滤支持 actor；合作方员工列表过滤。
- org 侧的「平台支持访问记录」页面。
- 每次写入都带上运营 id 的细粒度审计。

## 任务

| # | 内容 | 依赖 |
|---|---|---|
| S1 | 迁移：`platform_org_id` 设置、`is_platform_operator`、`support_grants` 表 + pgTAP | — |
| S2 | 迁移：`ensure_support_identity` / `ensure_support_actor` / `support_grant_active` + pgTAP | S1 |
| S3 | FC：`isPlatformOperator` 改判定；`whoami` 返回值不变 | S1 |
| S4 | OpenAPI + FC：进入、退出接口，定时清理过期 grant；route/repository/contract 测试 | S2, S3 |
| S5 | 桌面端：「所有组织」入口、保存/恢复运营会话、支持模式横幅、支持模式下不绑定 daemon | S4 |
| S6 | 配置：self-host 与 belayo 写 `platform_org_id`；确认 belayo 上运营身份为 4 | S1 |
| S7 | iOS（可选，后续） | S4 |

## 风险与注意

- **合作方库**：支持账号是客户 org 里 `admin_type 2` 的 `public.users` 行，会出现在合作方的
  员工列表里；它的 JWT 在同一个 GoTrue 上，也能以该 org 员工身份调用合作方 API。
  已决定第一版不处理，上线前告知合作方。
- 支持账号的凭据只能由 FC 用 service role 签发（无密码、无验证码渠道），风险等同
  service key 泄露。
- 仓库是 PUBLIC：文档、测试、提交里不写生产 org id、手机号、真名。
- 迁移要同时考虑 belayo 手工执行（不自动跑迁移），记账本。
