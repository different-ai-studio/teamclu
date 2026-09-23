# App 登录按租户收窄

2026-09-23。涉及 `services/fc/src/lib/apps-login-service.ts`、
`apps-auth-gate.ts`、`apps-vanity.ts`、`supabase-repo/phone-auth.ts`、
`src/index.ts`，以及迁移 `20260923200000_apps_org_id_tenant_pointer.sql`。

## 起因

用户报：app 的登录页登录成功后，账号选择器列出的是这个手机号在**所有 org** 的
员工，期望只限当前租户。

## 根因

登录页和登录墙用的是两套互不相通的 org 概念，而登录页那套**根本不存在**。

1. **登录页不知道租户是谁。** `LOGIN_APP_COLUMNS` 只有
   `id, slug, name, team_id, auth_mode, custom_domain, custom_domain_verified_at`,
   `LoginApp` 类型里没有任何 org 字段。
2. **手机号查询刻意跨 org。** `phone-auth.ts` 按 `mobile` 单条件查
   `public.users`，注释写明不按 org 收窄——因为旧的 `defaultOrgId` 过滤会在
   `switch_active_team` 改写 `public.users.org_id` 之后查不到人、把人当新用户
   重新注册。这个理由成立，所以修法不是把那个过滤加回去。
3. **org 限制存在，但在登录之后。** 网关的 `auth_audience` 比对访客 org 和
   app 所属 team 的 `teams.oid`，拒绝时给 `wrong_org`。于是时序是「选择器列出
   全部 → 用户选 → 网关事后拒」。

## 线上数据（belayo，2026-09-23 实测，聚合）

| 事实 | 数值 |
|---|---|
| 同手机号跨多个 org | 2 行的 35,148 个里 34,650 个跨 org；3 行的 7,624 个里 7,621 个 |
| 同一个 org 内同手机号多行 | 1,220 组 2 行（795 组 admin_type 不同、796 组 email 不同）+ 13 组 3~8 行 |
| `public.users` 总行 / 有 `auth_user_id` | 629,445 / 78,779，其中 78,767 行 `id = auth_user_id` |
| 带登录墙的 app | 24 个里 2 个（`banana-hire2` = any、`banana-store-scheduling-assistant` = org） |
| 两者的租户 | 都是香蕉攀岩 `5f7cb659`，429,828 用户，其中 1,448 有角色 |
| 角色构成 | 教练 300 / 前台 209 / 运营 196 / 定线组 155 / 财务 106 / 门店员工 85 / 管理员 74 |

**betly 的做法与此相反，已核对源码**：`saas-mono` 的
`apps/api/src/services/main-org-anchor.ts` 把每个手机号锚定到**主组织
admin_type=1**，不变式明写「不得以门店组织的会员/员工身份发放会话」，且
`#4559 ①` **删掉了 MULTI_USER 选择器**。主组织是 Betly 倍拓（338 人），不是租户。
本方案**有意不照搬**，是 teamclu 自己的身份模型。

## 决策（全部由产品方拍板）

1. 同一个手机号算同一个人。
2. 不照搬 betly：按租户过滤 + 保留选择器 + 自动开户。
3. 选择器展示 `admin_type` 和 email。
4. `apps.org_id` 改成**活的租户指针**。
5. 一次迁移完成回填 + 外键 + `upgrade_account_to_org` 级联；`NOT NULL` 随后补上。
6. 网关一并改读 `apps.org_id`，`teams.oid` 在 apps 链路上不再被读。
7. **所有** app 登录页都按租户过滤，不看 `auth_audience`。
8. 过滤只做在 apps-login 层；`phone-auth.login()` 加可选参数，`/v1` 不传即零变化。
9. 不允许开户且租户内无账号 → 明确报错，不回退到全量。
10. 自动开户只在 audience 解析为 `any` 的 app 上做。
11. 开户判据用 **app 级**事实，不看访客可控的 `next`。
12. 开户写 `admin_type = 1`。见下方风险。
13. 复用该手机号已有的 auth 账号，只插新 `public.users` 行。
14. app 登录不写 `app_metadata.org_id`。
15. `banana-hire2` 的 `/admin` 由运营在桌面 UI 加角色（`auth_audience` 是推导值，
    由 `buildAuthPolicyPatch` 从各路径的 roles 算出，不能直接设）。
16. 补绑 `auth_user_id` **只对 `admin_type = 1` 的行**做。
17. （09-24 追加）`apps.org_id` 加 `NOT NULL`；`createApp` 在建 app 时就写入，团队没有
    org 时返回 409 `team_has_no_org` 而不是让约束以 500 冒出来；finalize 那个
    `needsDatabase` 条件去掉——新语义下静态 app 也有租户。
18. （09-24 追加）用触发器挡住「带数据库 app 的团队升级账号」，不拆列。

## 后续发现：这个列确实身兼二职，用触发器把冲突挡在门外

2026-09-24 做 `NOT NULL` 那一步时发现，`apps.org_id` **同时是数据库定位符**——
`orgDatabaseName(orgId)` 拼出 `tc_org_<hex>`，app 的 schema 就在那个库里。
`supabase-repo.test.ts` 有一条测试把话说死了：

> **The whole point of the column.** Re-deriving here would provision a fresh
> empty schema in `tc_org_<new>` and take the app live with no data, while the
> real data sits untouched in `tc_org_<old>`.

于是决策 5 的级联是危险的：账号升级会把 app 的 `org_id` 指向新 org，而 schema 还在
旧库，下次部署就在新库建一个空 schema 上线。**测试套件抓不到**，因为级联在迁移里、
不在代码里；CI 当时是全绿的。

暴露面：`upgrade_account_to_org` 要求团队当前在 DEFAULT_ORG，而那 15 个团队名下
0 个 app，所以**当时触发不了**，是埋着的雷。

**取法（产品方选定）**：不拆列，用触发器把冲突挡在门外。

- `amux.app_type_needs_database(text)` —— `validation/app-type.ts` 里 `needsDatabase`
  的 SQL 版本。**两处必须同改**：那边加了新类型而这边没加，会被当成无 schema 放行。
- `guard_team_org_move` —— `before update of oid on amux.teams`，团队名下有带数据库
  且 `org_id` 非空的 app 时直接 `raise`，并点名是哪几个 app。做成触发器而不是写在
  `upgrade_account_to_org` 里面，是因为这条规则是关于 `teams.oid` 的，不是关于某一个
  恰好在写它的函数。
- 级联同时收窄成「只搬无 schema 的 app」。规则说了两遍：触发器被删掉时，退化成
  「租户不再跟着走」而不是「静默丢数据」。

实测：带数据库的团队被拦下并点名 `banana-hire2, banana-store-scheduling-assistant`；
只有静态 app 的团队放行。

**代价**：带数据库 app 的团队从此不能升级账号。这是刻意的——在「丢数据」和
「拦住一个不常见操作」之间选后者。

## 两处必须记录的取舍

**`admin_type = 1`（决策 12）。** belayo 的 `public.users` 是合作方的会员表，
`admin_type=1` 读作「在这家店办了卡」。给一个只是登录过某应用的人写这一行，等于
往合作方生产会员表里插一条事实上不成立的会员记录，且与真实会员无法区分
（香蕉攀岩现有 429,251 行 admin_type=1 是真实办卡用户）。实现方建议另设一个
「仅登录身份、非会员」的表达，产品方明确选择写 1。**此处如实记录，未来出问题
时这是第一个要看的地方。**

**补绑即认领（决策 16）。** 550,666 行没有 `auth_user_id`，而网关正是按这一列
解析身份，不绑等于不可达。但绑定实质不可逆，而国内号码会回收再放号——新机主
一登录就继承前机主的身份。因此只对会员行开放：继承一张会员卡是麻烦，继承
教练/财务的员工行是提权，而员工行恰恰是 `audience=org` 应用的准入凭据。

## 实现要点

**网关的访客解析换了问题。** 原来按 `public.users.id = <auth uid>` 单行读那一行
的 org；因为 `public.users.id` 对已登录用户就是 auth user id，这只能表达「一个
auth 账号一个 org」。改成问「在该租户有没有身份」：
`auth_user_id = <uid> AND org_id = <appOrgId>`，返回行 id。

**连带必改**：`roles_users.user_id` 指向 `public.users.id`（2,246/2,246），所以
角色查询必须按解析出的身份行 id，而不是 auth uid。两者只在主行上相等，这个错误
在跨租户之前完全不显形。已有回归测试钉住。

**租户收窄时跳过 `accountsForPicker`**，理由是它自己的注释：它存在是因为不收窄的
选择器会「变成这个人爬过的所有岩馆的列表」，那是关于别的 org 的行。

## 上线顺序

`belayo-cloud-api.yml` **只发代码、永不跑迁移**（其头部注释写明）。所以：

1. PR 合并
2. belayo 手工跑迁移，确认 `apps.org_id` 24/24 有值
3. 发 FC 代码
4. 在 `banana-hire2` 验自动开户；在 `banana-store-scheduling-assistant` 验
   「非员工进不去」

self-host 的 `migrate` compose 服务会自动跑迁移，不用管。

迁移已在 belayo 真实数据上以回滚事务试跑：`UPDATE 19`、24/24 有值、
0 行与 team 的 oid 不一致、外键建立成功。
