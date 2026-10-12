# 只认员工的身份模型：每个 org 一个身份，废除 DEFAULT_ORG

- 日期：2026-10-08
- 状态：T1–T8、T9a 已实现（分支 `task/teamclaw-login-staff-only`）；T9b、T11 待人工确认后进行
- 总览 issue：#1647

## 背景

在与合作方共用 `public.users` 的部署上（belayo），这张表是合作方的会员表：
`admin_type = 1` 的行是会员卡，不是 TeamClu 账号。按手机号匹配会把一个人在各家门店的会员卡
全部带出来，TeamClu 曾以会员卡身份登录、切换团队，造成选错账号和身份串用。

同时，合作方后台（saas-mono）的 `/api/admin/*` 整体要求 `admin_type ∈ {2,3,4}`，
按 `public.users.id = 登录账号 id` 查行。TeamClu 的成员和数字员工若是 1，后台接口全部拒绝。

另外，DEFAULT_ORG 身兼多职：手机号账号的命名空间、合作方自己的公司 org、以及合作方 App
「岩友锚点」所在的主组织。TeamClu 手机号注册写进的那一行，就是合作方 App 的锚点行；
`move_caller_to_own_org` 改它的 org_id，会破坏合作方「锚点必须在主组织、admin_type = 1」的不变式。

## 决定

1. **TeamClu 只认 `admin_type >= 2` 的身份。** 登录、切换团队、团队列表都按这一条；不再有来源标记，
   不再有 DEFAULT_ORG 特例。
2. **每个 org 一个身份，每个身份一个独立登录账号。** 这与合作方自己的模型一致
   （saas-mono 按 `public.users.id` 认人）。只往 `public.users` 加一行、用 `auth_user_id`
   挂到已有账号是不行的：saas-mono 看不到这种行。
3. **第一个身份用这个人的真实登录账号**（身份行 id = 账号 id）；从第二个身份开始用合成账号：
   - 手机号用户：第一个 `<phone>@teamclu.mobile`，之后 `<身份 id>@teamclu.mobile`
   - 邮箱用户：第一个是真实邮箱，之后 `<身份 id>@teamclu.email`
4. **新租户**：用户必须输入团队名（不预填），同一个名字写进 org 名和团队名；
   创建者 `admin_type = 3`。
5. **成员邀请**：只有该 org 的员工（`admin_type >= 2`）发出的成员邀请有效；被邀请人得到
   该 org 下的新身份，`admin_type = 2`。**接受邀请不再搬家**，不改原身份的 org，不删原 org 的团队。
6. **数字员工**：员工邀请的 bot 账号为 `admin_type = 2`，否则 1（已实现，`20261008010000`）。
7. **「同一个人」的判断**：手机号用户靠 `mobile`；邮箱用户靠新表 `public.email_users_links`
   （`email` → `user_id`，结构仿 `wechat_mp_users`）。不复用 `wechat_mp_users`：合作方 19 处代码
   把它当真实微信绑定（绑定状态、解绑、对外接口）。
8. **不碰合作方的岩友锚点**：锚点账号和主组织里 `admin_type = 1` 的那一行归合作方，TeamClu 不改、
   不用它登录。
9. **老客户端**：服务端对不传团队名的老版本暂时放宽（用推导名），新客户端强制必填；老版本退场后收紧。

所有对 `public.users` 的写入都是 INSERT：合作方库上 `prevent_admin_type_change` 只允许
service_role 在 UPDATE 中改 `admin_type`，INSERT 不受限。

## 登录流程

**手机号**：验证码通过 → 按 `mobile` 找所有 ≥2 的身份 → 一个直接登录、多个让用户选（显示 org 名）
→ 一个都没有：建 `<phone>@teamclu.mobile` 账号（不写身份行），返回 `needsTenant`，客户端进入新租户流程。

**邮箱**：GoTrue 按真实邮箱签发会话 → 查 `email_users_links` 找所有 ≥2 的身份 → 同上；
选中合成账号的身份时，服务端为该账号签发会话（凭真实邮箱的会话换取）。
没有身份 → 先看待接受的邀请，没有则进入新租户流程。

**切换团队**：`switch_active_team` 按同一个人的所有 ≥2 身份找 actor，签发对应身份的会话。

## 实现记录（与上文任务表的差异）

- **「只认员工」是数据库设置，不是参数也不是环境变量。** `amux.deployment_settings`
  的 `staff_only` 键 + `amux.staff_only()`；登录（FC 读取）、切换团队、团队列表、成员邀请
  共用这一处。RPC 参数可被直连 PostgREST 的调用方省略，会让「只有员工能邀请」形同虚设，
  所以不用参数；原先的 `PHONE_LOGIN_STAFF_ONLY` 环境变量已删除。开启方式（各环境手工）：
  `insert into amux.deployment_settings (key, value) values ('staff_only', 'true');`
  **在 T11 完成前不要开启**：存量 `admin_type 1` 的身份会被拒。
- **T3 没有新增 `create_tenant`**：`amux.ensure_personal_org` 是 bootstrap 与 create_team
  共用的建 org 入口，直接在这里写 admin_type 3、mobile、邮箱关联；create_team 现在也把团队名
  作为 org 名传入（iOS 建团队走这条路）。
- **T5 落在两个 SQL 函数**：`amux.list_my_identities()`、`amux.mint_identity_session(id)`，
  对应 `GET /v1/auth/identities`、`POST /v1/auth/identities/:userId/session`。
- **T7 并入 T1/T2 的迁移** `20261008000000`：switch_active_team / list_teams_for_picker
  保持原签名，改用 `amux.person_identities()`。
- **短信配置**改读 `SMS_CONFIG_ORG_ID`（未设时回退 `DEFAULT_ORG_ID`），为 T9b 删除
  `DEFAULT_ORG_ID` 做准备。
- **T9 拆成两步。** T9a（已做）：停止向 DEFAULT_ORG 写新数据——手机号注册（T4）、
  绑定手机号接口（改为 410）。T9b（待 T11 之后）：拆除 bootstrap 共享分支、
  `move_caller_to_own_org`、picker/join 的 `p_default_org_id`、`getHomeOrgId` 特例、
  `clampSharedTenantRole`、升级账号流程、`DEFAULT_ORG_ID`。这些分支现在保护的是 DEFAULT_ORG
  里的存量用户，提前拆会重新打开 2026-09-09 修掉的跨租户泄露。

- **T12 应用登录页（FC 托管的 app 登录）**：网关按 `auth_user_id = 会话账号` 在 app 的 org
  里找身份。手机号登录本来就按租户登录；邮箱 / 密码 / OAuth 和跨 app 的 SSO 捷径原先直接用
  「登录的那个账号」，邮箱用户在受邀 org 的身份（合成账号）会被拒。现在由
  `apps-tenant-identity.ts` 按同一个人（同手机号 / 邮箱关联）换成该 org 的身份；SSO 捷径
  在对方没有该 org 身份、且 app 需要 org 成员时退回登录页，而不是进「无权访问」。查不到
  （例如库里还没有 `email_users_links`）时保持原账号。app 自助注册复用手机号账号时优先会员行，
  不挂到员工身份的账号上。

迁移：`20261008000000`（T1/T2/T7）、`20261008010000`（bot）、`20261008020000`（T6）、
`20261008030000`（T3）、`20261008040000`（T5）。belayo 需手工按序执行；都是只加不改或
`create or replace`，可先于代码上线。`email_users_links` 建在 `public`，执行前需完成 T0。

## 任务

| # | 任务 | 依赖 |
|---|---|---|
| T0 | 与合作方对齐：在 `public` 建 `email_users_links`；TeamClu 会在其表中建 org 和 admin_type 3/2 的用户；锚点不碰 | — |
| T1 | 当前分支收尾：「只认员工」去掉 DEFAULT_ORG 兜底，改纯 ≥2；删除复用合作方锚点邮箱的 `ensurePlatformAuthUser` | — |
| T2 | 建 `public.email_users_links`（RLS、无策略）；`amux.person_identities(user)` 返回同一个人所有 ≥2 的身份 | T0 |
| T3 | 新租户 RPC `amux.create_tenant(p_team_name)`：INSERT org、身份行（admin_type 3）、团队、owner actor、`roles_users` owner；邮箱用户写关联；老客户端不传名时用推导名 | T2 |
| T4 | 手机号登录重写：按 ≥2 找身份；无则建 `@teamclu.mobile` 账号并返回 `needsTenant`；签发选中身份的会话；短信配置不再按 org 读取 | T1, T2 |
| T5 | 邮箱登录选身份：验证后返回身份列表；`POST /v1/auth/identities/:id/session` 换取目标身份会话 | T2 |
| T6 | 成员邀请：发起人须为该 org ≥2；claim 不再搬家，按「第一个身份用真实账号」规则建身份（admin_type 2），写关联，返回新身份会话 | T2 |
| T7 | `switch_active_team` / `list_teams_for_picker` 改用 `person_identities` | T2 |
| T8 | 客户端：团队名必填不预填（桌面、iOS）；邮箱登录后的身份选择；接受邀请后采用新会话（iOS 补齐）；处理 `needsTenant` | T3–T6 |
| T9 | 拆 DEFAULT_ORG：bootstrap 共享分支、`move_caller_to_own_org`、picker/join 的 `p_default_org_id`、`getHomeOrgId`、`clampSharedTenantRole`、升级账号流程、`bind_phone_to_account` 默认 org、`DEFAULT_ORG_ID` 环境变量（SQL 参数先保留不用） | T3–T8 上线 |
| T11 | 存量数据迁移：自建 org 的创建者提为 3（service_role）；被迁出主组织的锚点归位；接受邀请时搬过家的人；self-host 存量。完成后所有环境默认只认员工，删除 `PHONE_LOGIN_STAFF_ONLY` | T9 |

T10（bot 规则）已在关联分支完成。

## 上线顺序

T0 → 迁移（按序）→ FC → 客户端 → T11（人工确认）→ 开启 `staff_only` → T9b。
T6 必须先于或与 T3 同时上线，见「跨 org 超管」——它们在同一批迁移里。
belayo 的迁移手工执行，必须先于依赖它的代码；新增 RPC 参数一律带默认值。

## 风险与注意

- **跨 org 超管**：在 T6 完成前，旧的 claim 会把接受邀请者的 org 改成邀请方的 org 且保留 admin_type；
  T3（创建者为 3）不能先于 T6 上线。
- **合作方后台可见性**：TeamClu 建的 org 和用户会出现在合作方后台（T0 需确认可接受）。
- **合成邮箱域名一旦启用不可改**：它是账号身份的一半。
- **公开仓库**：文档、提交、测试中不写生产数据中的姓名、手机号、org id。
