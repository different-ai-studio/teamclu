# 登录后 org / 团队重设计 Implementation Plan

> **For agentic workers:** 已实现完毕（分支 `feat/login-org-team-redesign`）。本文件保留为
> 设计与决策记录；下面标注 ⟨实现差异⟩ 的地方是动手时与计划不同的部分，以代码为准。

**Goal:** 干掉「所有新用户挤进一个共享 org、各自建一个同名团队」这套逻辑。新用户自建 org（名字取自本人）+ 一个与 org 同名的 public 默认团队；已属于某 org 的人加入该 org 的 public 团队而不是再造一个；是否允许自助注册由部署级开关决定；匿名 / 快捷试用整个删除。

**现状与病灶:** `AuthGate.tsx:285-420` 是唯一的决策点。列表为空就 `POST /v1/teams/bootstrap` → `bootstrap_current_org_team` → org 取 `current_org_id() ?? DEFAULT_ORG_ID`，团队名取 org 名。线上 Google 用户没有 org 声明也没有 `public.users` 行，于是全部落进 `DEFAULT_ORG_ID`（名为 "TeamClaw Public" 的共享 org），每人造一个同名私有团队 —— 线上已有 3 个。`create_team` 本来明确拒绝用 org 名当团队名（`20260618000000_...sql:56-58`），被 `bootstrap_current_org_team` 显式传参盖掉。

**Architecture:** org 解析链收缩成 `current_org_id() ?? ensure_personal_org()`，`DEFAULT_ORG_ID` 退出这条链、只留给 phone-auth。`ensure_personal_org` 不再叫 'Personal'，按 nickname 解析。有 org 的人走 `ensure_org_default_team`（public、org 同名、按 org 上咨询锁），选择器列出后走 `join`。注册开关守的是「新建 org」这一个动作。

**不做（明确冻结）:** 手机号登录（`services/fc/src/lib/supabase-repo/phone-auth.ts`）、WebSSO 快捷登录、belayo 的任何存量迁移、`public.users` 与 partner SaaS 的共享模型、MULTI_USER 一号多账号、admin 建 user 接口、应用内「新建团队」入口。

---

## 两个关键取舍（已定，不要再翻）

**团队名跟 org，不是随机。** org 名 = 本人（nickname → OAuth `full_name`/`name` → 邮箱前缀），团队与 org 同名，所以新用户的团队就叫 `evan chow`。「Google 建的团队名要随机」这条早期规则是在旧前提（Google 用户落进共享 org、团队被叫成 "TeamClaw Public"）下提的，已被此设计取代 —— **随机名只剩解析链最后一环的兜底**。

**注册开关只在 FC 层强制，接受已知绕过。** FC 转发调用者 bearer token，这些 RPC 以 `authenticated` 身份执行，因此不能把 grant 收到 service_role；而 Supabase 网关公网可达，手搓 `POST /rest/v1/rpc/ensure_personal_org` 能绕过 FC 直接建 org。这是**明知并接受**的：开关的用途是产品形态（把自助注册关掉、走邀请制），不是安全边界。若哪天需要真正的强制，做法是把 flag 落到单行 `amux.deployment_settings` 并在 `ensure_personal_org` 内部判 —— 但那不属于本次 scope。

---

## 目标行为

```
拿到 session
├─ 有 pendingInviteToken → claim_team_invite（不变）
└─ 解析 caller org
   ├─ current_org_id() 为空
   │   ├─ 允许新建 org → ensure_personal_org() + 与 org 同名的 public 默认团队
   │   └─ 不允许       → 403 registration_disabled → 等邀请屏
   ├─ current_org_id() == DEFAULT_ORG_ID → 走今天的老路（belayo 冻结，见 CS-3）
   └─ 其他真实 org
       ├─ 该 org 无 public 团队 → ensure_org_default_team 建一个
       └─ 有 → 选择器列出，走 join
```

---

## 文件

- Add: `services/supabase/migrations/<ts>_org_naming_and_team_bootstrap.sql` — CS-1
- Add: `services/supabase/migrations/<ts>_org_default_public_team.sql` — CS-2
- Add: `services/supabase/migrations/<ts>_join_public_team_org_scope.sql` — CS-4
- Add: `services/supabase/migrations/<ts>_drop_guest_device_teams.sql` — CS-8 最后一步
- Modify: `services/fc/src/lib/supabase-repo.ts` — org 解析链、`ensure_org_default_team`、删 guest 分支
- Modify: `services/fc/src/lib/routes/teams.ts` — 删 `deviceId` / `orgId` 入参
- Modify: `services/fc/src/lib/routes/auth.ts` — `/v1/auth/signin-anonymous` 返 410
- Modify: `services/fc/src/lib/feature-profiles.ts` — 注册开关
- Modify: `packages/app/src/components/auth/AuthGate.tsx` — 403 分支、删客户端预判、删匿名分支
- Delete: `packages/app/src/components/auth/GuestTeamDiscovery.tsx`
- Modify: `packages/app/src/components/auth/{TeamPicker,LoginScreen,DesktopOnboarding,UpgradeAccountDialog}.tsx`
- Modify: `packages/app/src/stores/auth-store.ts` — 删 `signInAnonymously` + upgrade 全套
- Modify: `packages/app/src/lib/backend/{types.ts,cloud-api/{auth,teams,device-id}.ts}`、`lib/auth/auth-client.ts`
- Modify: `apps/ios/Packages/AMUXCore/Sources/AMUXCore/CloudAPI/Auth/CloudAPIAppOnboardingStore.swift`、`Onboarding/AppOnboardingCoordinator.swift`、`AMUXUI/Sources/AMUXUI/Settings/{UpgradeAccountSheet,SettingsView}.swift`
- Modify: `apps/expo/src/lib/auth/cloud-auth.ts`、`features/onboarding/*`、`features/settings/screens/SettingsScreen.tsx`
- Modify: `docs/openapi/teamclu-api.v1.yaml`
- Modify: `services/supabase/tests/027_org_default_team_selection.sql`、`029_empty_org_public_bootstrap.sql`
- Modify: `deploy/self-host/all-in-one/render-config.sh` — `GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED`

---

## Phase A —— 纯 SQL + FC，无客户端依赖

### CS-1: org 命名 + 团队命名 + 去匿名分支

一个 migration，改两个函数。**匿名分支的删除并进这里**（与团队命名改的是同一个函数，不要拆两个 migration）。

`amux.ensure_personal_org()`（现 `baseline.sql:1938` 硬编码 `'Personal'`）：org 名按序解析

1. `public.users.nickname`
2. `auth.users.raw_user_meta_data ->> 'full_name'`
3. `auth.users.raw_user_meta_data ->> 'name'`
4. `split_part(auth.users.email, '@', 1)`
5. Adjective Animal 兜底

第 5 步不能省：`bootstrap_current_org_team` 对空 org 名直接 `raise ... errcode = '23514'`。2/3 是 Google/Apple OAuth 实际写入的字段（线上样本两者皆为 `evan chow`）。保留现有 race 分支（insert 撞 `users_pkey` → 删掉刚建的 org → 重读）。

**不要复用客户端传来的 `p_display_name` 当 org 名** —— `resolveDefaultDisplayName` 是「操作系统账户名优先」，统一装机的机器上会拿到 IT 管理员名。它继续只作 owner actor 名。

`amux.bootstrap_current_org_team()`：团队名判据从 `v_is_anonymous` 换成「org 是不是调用者自己的真实 org」，同时删除匿名分支。

存量不回填：已有 org 名不动。

### CS-2: org 默认 public 团队

新 RPC `amux.ensure_org_default_team(p_org_id uuid)`：

- 进入即 `pg_advisory_xact_lock(hashtextextended(p_org_id::text, 0))`。`amux.teams` 上 `(oid, name)` 无任何约束（只有 `teams_slug_key`），同 org 两人并发登录会造出两个
- 幂等键用「该 org 下是否已存在 public 团队」，**不要用同名**。名字键改名即失联；slug 因去重后缀 + 全中文归一成 `team-N` 也不可用
- 建团时显式 `visibility = 'public'`（`create_team` 从不设它，列默认 `private`）
- 绕不过 `create_team` 的 first-team-only 守卫（`20260618000000_...sql:45-48`）。**把 `create_team` 的 insert 块抽成内部函数**，两边共用，不要复制粘贴

⟨实现差异⟩ 函数最终叫 `amux.ensure_org_public_team`，不是 `ensure_org_default_team` ——
baseline 里已经有一个同名 `(uuid, text) -> uuid` 的遗留函数（`app.*` schema 时代，只插一行
teams，无调用点），返回类型不同会直接建不出来。遗留那个原样留着，删它属于另一件事。

⟨实现差异⟩ 计划担心的 `027_org_default_team_selection.sql:48`「bootstrap 不静默加入」**没有失效**：
`bootstrap_current_org_team` 在这方面语义未变，加入行为落在新函数 `ensure_org_public_team` 里。
027 连同 002/028/029/031/032 全部照常通过（已在线上 schema 上 begin/rollback 实跑验证）。
新增 `033_org_public_default_team.sql` 覆盖新路径，8 条断言全绿。

### CS-3: `DEFAULT_ORG_ID` 收窄

- 从 org 解析链移除：`supabase-repo.ts:545`（`createTeam`）、`:592`（`bootstrapTeam`）
- 摘掉两个空签名参数：`listAllMyTeams` → `list_teams_for_picker(p_default_org_id)`、`joinPublicTeam` → `join_public_team(p_default_org_id)`。**两个函数体都不引用它**。SQL 签名瘦身可选（DROP + CREATE 需手动恢复 grant）
- env 保留，唯一消费者变成 `phone-auth.ts:108`（该处无 org 即 throw）

🔴 **必做，否则 belayo「冻结」不成立**：规则 3/4 加 `DEFAULT_ORG_ID` 排除项。belayo 跑同一套代码与 schema，缺这个排除，一部署它的手机号用户就会被规则 4.1 收敛进同一个团队。

### CS-4: `join_public_team` 加 org 校验

线上函数体只校验 `visibility='public'` 与非匿名，**不校验 org**。CS-2 之后每个人的默认团队都是 public，等于任何持有 team id 的账号都能加入。加 `t.oid = amux.current_org_id()`。

副作用：切断跨 org 加入公开团队。今天全库仅 "Public Playground" 一个 public 团队，且 `GuestTeamDiscovery` 在 CS-8 中删除。

---

## Phase B —— 注册开关 + 客户端

### CS-5: 注册开关（守「新建 org」）

- flag 定义在 `services/fc/src/lib/feature-profiles.ts`（per-deployment，durable 值进 git，`APP_FEATURES_JSON` 仅应急）
- 抽 `resolveCallerOrg({ allowCreate })`，`bootstrapTeam` 与 `createTeam` 共用；拒绝时 403 `registration_disabled`。**两个调用点必须共用**，否则 Expo 的建团页是后门
- 经 `/v1/config/{public,bootstrap}` 下发供客户端渲染
- `GOTRUE_DISABLE_SIGNUP` **保持 `false`**：邀请对象在 GoTrue 中并不存在（邀请是 `amux.team_invites` 一行），关掉 signup 会让邀请制自锁。代价是库中会积累无团队的 `auth.users`，可接受
- **只在 FC 层强制**，不做 SQL 侧兜底。已知可绕过（见开头「两个关键取舍」），这是接受的结果，不要顺手去补

### CS-6: AuthGate 接 403

- `registration_disabled` → `teamAssignmentRequired = true` → `bootstrap = "no_team"`；不得掉入 `TeamBootstrapErrorScreen`
- 删除客户端预判 `extensionRequiresInvitation`（`AuthGate.tsx:134-135, 342-345`），改由服务端 403 驱动
- `ExtensionNoTeamScreen` 通用化：文案来源 `extensionTeamOnboarding.noTeamMessage` 是扩展专用 bake，需换通用来源

### CS-7: 空 org 分支移除

规则 4 使其自动化，整条删除：`p_include_empty_orgs`、`item_type='org'` 占位行、`bootstrap_selected_org_team`、`bootstrapTeam({ orgId })`、`TeamPicker` 的 `emptyOrg` 分支与 "Initialize {{org}}" 文案。`services/supabase/tests/029_empty_org_public_bootstrap.sql` 随之调整。

---

## Phase C —— 删匿名（独立，可与 A/B 并行）

### CS-8

**P0 先定存量**（阻塞）：线上 103 个匿名 user 及其团队 —— 留着自然消亡 / 先发一版「绑定邮箱」提示再删 / 直接清。不定则后续每步都要预留两种写法。

**P1 三端客户端**（可并行）
- `packages/app`：14 文件 55 处。大头是 `auth-store.ts`（17 处，含 `sendUpgradeEmailOtp` / `verifyUpgradeEmailOtp` / `upgradeEmail` / `upgradePhone` 整套）、`AuthGate.tsx`（7 处）、`GuestTeamDiscovery.tsx` 整删、`UpgradeAccountDialog.tsx`、`app-sidebar.tsx`、`DesktopOnboarding.tsx` 快捷试用、`LoginScreen.tsx` "Try anonymously"。locales 中 `quickTrial` / guest 相关键要一并清（i18n-parity 是权威死键守卫）
- `apps/ios`（最大，且需发 TestFlight）：`CloudAPIAppOnboardingStore.swift:209-360`（`signInAnonymously` + anonymous→Apple/Google/email 升级段）、`AppOnboardingCoordinator.swift:114-152,638,836`。`SessionStore` / `KeychainSessionStorage` 的 `isAnonymous` 字段**保留为只读**，删除需处理旧 Keychain 数据解码
- `apps/expo`：`cloud-auth.ts`、`onboarding-{store,reducer,types}`、`HomeScreen` / `CreateTeamScreen` / `SettingsScreen` / `ChooseAuthScreen`

**P2 服务端封口**（一次部署）
- `ENABLE_ANONYMOUS_USERS=false` —— 两处：`deploy/self-host/supabase/docker-compose.yml:123`（走 .env）与 `deploy/self-host/all-in-one/render-config.sh:71`（硬编码 `true`）
- `services/fc/src/lib/routes/auth.ts:13` 的 `/v1/auth/signin-anonymous` 返 410
- `supabase-repo.ts:600-627` 删 `claim_guest_device_team` 分支与 `SHARED_DEVICE_ID_PLACEHOLDERS`；`routes/teams.ts:76` 删 `deviceId` 入参。**只删 bootstrap 这一个 `deviceId`** —— agent 绑定 / push / presence 中的同名字段一律不动

**P3 SQL**（最后，不可逆）
`drop function claim_guest_device_team`、`drop table guest_device_teams`。`bootstrap_current_org_team` 的匿名分支已在 CS-1 处理。
`join_public_team` / `claim_team_invite` 中的匿名守卫**保留**（零成本纵深防御）。`list_discoverable_teams` 的 `anon` grant 收回。

---

## CS-9: 文档与测试（贯穿）

- OpenAPI：`deviceId`（:204-208）、`/v1/auth/signin-anonymous`（:4512）、`scope=discoverable`（:79-85）、新增 403 `registration_disabled`
- pgTAP：027 断言更新（CS-2）、029 调整（CS-7）、新增 org 默认团队幂等 / 并发用例
- 前端测试 11 个文件：`auth-store.test.ts`、`AuthGate.test.tsx`、`DesktopOnboarding.test.tsx`、`LoginScreen.test.tsx`、`auth-client.test.ts`；expo `onboarding-{reducer,store,api}.test.ts`；fc `auth-pg.test.ts` / `teams-activate.test.ts` / `pg-repo-sessions.test.ts`；iOS `AppOnboardingCoordinatorTests` / `CloudAPIAppOnboardingStoreTests` / `SessionStore(Storage)Tests`
- `docs/specs/2026-06-17-teamclu-phone-login-and-tenancy.md` 补一句「手机号路径冻结」

---

## 部署风险（本仓库特有）

1. push 到 `main` 且触碰 `services/fc/**` 或 `services/supabase/migrations/**` 会**自动部署到线上**。本计划几乎每个 CS 都触碰 —— 分支上做完一次性合，不要边改边合
2. FC `src/` 的类型错误会让整个 self-host 部署 + migration 一起挂（镜像构建用 `tsconfig.json`，不是 typecheck 那份 test 配置）
3. belayo Cloud API 由 Dokploy workflow 发布，数据库迁移保持独立人工执行。CS-3 的排除项未落地前不要往那边部署
4. 本 checkout 可能有其它 session 在用，开分支前先 `git branch --show-current`

## 建议顺序

`CS-1` →（`CS-3` ∥ `CS-4`）→ `CS-2` → `CS-5` → `CS-6` → `CS-7`；`CS-8` 全程独立并行。

`CS-1` 单独即可独立上线并验证流程（新用户团队不再叫 "TeamClaw Public"），适合作为第一刀。


---

## 实现记录（2026-08-17）

全部九个 change set 已实现并验证，分支 `feat/login-org-team-redesign`。

**验证结果**
- 四个 migration + 新 pgTAP：在线上 schema 上以 `begin; … rollback;` 实跑通过
- 既有 pgTAP 002 / 027 / 028 / 029 / 031 / 032：全绿，无回归
- FC：`tsc -p tsconfig.json`（镜像用的那份配置）通过；测试失败集与基线**逐条一致**（94 条，全部是需要活库的集成用例），净增 1 条通过用例
- 前端：`pnpm typecheck` 通过，`pnpm test:unit` 445 文件 / 2864 用例全绿，`pnpm lint` 0 error
- Expo：`tsc --noEmit` 通过，93 文件 / 572 用例全绿
- iOS：AMUXCore `swift test` 224 用例全绿；AMUXUI 与 AMUX app target 均 `xcodebuild` 成功
- OpenAPI：`redocly lint` 与基线同为 1 error / 7 warning（均为既有问题）

**未做（有意）**
- 存量数据一律不动：线上 103 个匿名用户及其团队、默认 org 里 55 个私有团队、117 个叫
  'Personal' 的 org，全部保持原样。migration 只改机制不改数据
- baseline 里的遗留 `ensure_org_default_team` 未删
- `listDiscoverableTeams` 的 repository 方法保留（路由已摘除），删它要连带动 pg-repo 与
  repository-contract，不在本次范围
