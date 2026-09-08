# Apps：终端用户登录（注册进我们的 Supabase）与自定义域名 — 设计

- 日期：2026-09-08
- 分支：`task/apps-mo-kuai-ji-chen`
- 行号基线：`8aae0a060`
- 前置文档：`docs/specs/2026-08-27-apps-self-serve-gitea-fc-design.md`（§6 `auth_mode`、§7 公开性、§8 路线图把「自定义域名」列在 Phase 2）

## 0. 一句话

给部署出去的 app 两样东西：一道**真正挡得住、且认得出员工**的登录墙（终端用户注册进我们
平台的 Supabase），和**用户自己的域名**。

登录做成**一个集中的登录服务**：登录页只有一份，跨 app 单点登录，自定义域名照样工作。

---

## 1. 现状核实

以下每条都对过源码或线上盒子，不是文档转述。

### 1.1 登录：云端架子是全的，墙在模板里，而模板是空壳

云端（`services/fc`）这半边已经存在：

| 件 | 位置 |
|---|---|
| GoTrue OAuth 客户端动态注册 | `services/fc/src/lib/provisioning/gotrue-oauth.ts` |
| client secret 封存 | `amux.app_secrets`（`provisioning/app-secrets.ts`） |
| 切换 `auth_mode` 时开通/回收 | `provisioning/app-auth-mode.ts:68` `applyAuthModeChange` |
| finalize 时注入函数 env | `app-auth-mode.ts:148-153` → `app-deploy.ts:275` |
| 成员校验端点 | `GET /v1/apps/:appId/membership`（`routes/apps.ts:173`） |

模板那半边是**空壳**。`templates/tanstack-postgres/src/lib/platform-auth.ts` 的文件头
原文：

> Platform SSO contract stub (`auth_mode=platform`). Phase 1: env helpers +
> membership fetch only — wire `/auth/login` + `/auth/callback` routes when
> implementing PKCE.

没有 `/auth/login`、没有 `/auth/callback`、没有会话、没有受保护路由。

**结论：今天在 UI 上选 `platform` 并部署，线上站点没有任何登录墙。** `deployed_auth_mode`
会如实记成 `platform`，控制面显示「已启用登录」，而任何拿到链接的人都能直接打开。

更糟一点：`AUTH_MODES`（`AppControlPanel.tsx:41`）**没有按 app 类型区分** ——
`static_web` 和 `slides` 也照样显示登录方式选择器，而它们连一个能跑登录逻辑的地方都没有
（纯静态 `server.mjs`）。这个 UI 现在是纯粹的空承诺。

### 1.2 线上两个硬堵点（2026-09-08 在 `47.112.210.217` 实测）

1. **GoTrue 的 OAuth server 是关的。** 版本 v2.188.1，二进制里有
   `envconfig:"OAUTH_SERVER"`、`AllowDynamicRegistration`、`/oauth/clients/register`，
   但带合法 service-role token 打 `/admin/oauth/clients` 返回 **404**（不带 token 是
   401 — 说明 admin 中间件跑到了、路由不存在）。
2. **`fc` 容器里 `APP_SECRETS_ENCRYPTION_KEY` 是空的。** client secret 封不进
   `app_secrets`，`applyAuthModeChange` 第一步就会失败。

这两条合起来解释了为什么 `platform` 模式从来没有真正跑通过。

> 本方案选定的路线**不需要**其中任何一个（见 §3 D2），两个堵点自动绕开。

### 1.3 现有登录是邮箱验证码，不是 magic link — 这一条决定了整个方案

线上 GoTrue 容器 env：

```
GOTRUE_MAILER_SUBJECTS_MAGIC_LINK=您的验证码：{{ .Token }}
GOTRUE_MAILER_AUTOCONFIRM=true
GOTRUE_DISABLE_SIGNUP=false
GOTRUE_URI_ALLOW_LIST=http://127.0.0.1:*/callback,teamclaw://auth-callback,teamclu://auth-callback,https://<两个扩展 id>.chromiumapp.org/
```

三个推论：

1. 产品现有的登录形态是**邮箱 6 位验证码**（OTP），与 `project_v2_auth` 记的
   「Tauri email-OTP only」一致。
2. `GOTRUE_URI_ALLOW_LIST` **不含任何 app 域名**。走 magic link 或
   `signInWithOAuth` 都需要 redirect 落在这个列表里，否则 GoTrue 会把 redirect 改写回
   `SITE_URL`，客户端永远拿不到 code。
3. **OTP 流程（`/otp` → `/verify`）压根不需要 redirect URL。** 这是唯一一种在**用户
   自己填的任意自定义域名**上也能直接工作的登录方式 —— 自定义域名不可能预先加进
   allow list。

登录与域名两个需求在这里正好咬合。

### 1.4 自定义域名：UI 是禁用占位，但底层很顺

- UI：`packages/app/src/components/apps/AppControlPanel.tsx:718-738`，输入框
  `disabled`，文案「即将支持」。
- 库里没有 `custom_domain` 列（`APP_COLUMNS`，`supabase-repo/shared.ts:106-107`）。
- 但 Caddy 已经在跑 on-demand TLS 且有闸门：`deploy/self-host/caddy/Caddyfile` 全局
  `on_demand_tls { ask http://fc:9000/internal/caddy/ask }`，闸门实现在
  `services/fc/src/app.ts:77`。
- 代理本来就是**按 Host 查 app 再转发**（`app.ts:85-96` → `apps-vanity.ts` 的
  `proxyToApp`）。加一个用户域名，本质上就是让「Host → app」这一步多认一种形态。

⚠️ **命名陷阱**：`fc-client.ts:265` 的 `ensureCustomDomain` / `app-delete.ts:56` 的
`deleteCustomDomain` 指的是**阿里云 FC 侧的路由域**
（`<label>.$APPS_FC_ROUTE_DOMAIN`），跟本文说的「用户自己的域名」完全是两回事。本方案
不碰它们，新代码一律用 `vanityDomain` / `userDomain` 措辞区分。

### 1.5 org 与 team 是两层，现有 membership 端点判的是 team

| 事实 | 位置 |
|---|---|
| `getAppMembership` 判的是 **team 成员** | `supabase-repo.ts:3831` `resolveCurrentMemberActor(row.team_id, userId)` |
| org 成员关系 = `public.users.org_id`，一人一个 org | `baseline.sql:4615-4632`，表注释：`SUBSET mirror of saas-mono public.users (user↔org)` |
| app 的 org 要从 team 取，**不能读 `apps.org_id`** | 静态 app 那列是 null（finalize 只在 `needsDatabase` 时写）；`resolveTeamOrgId()` 是现成路径 |
| `teams.oid` 可空 | `baseline.sql:1512` `oid uuid`（无 not null） |
| 权威的 org 解析逻辑 | `amux.current_org_id()`：JWT `app_metadata.org_id` → 回退 `public.users.org_id where u.id = auth.uid()` |

⚠️ 注意 `current_org_id()` 匹配的是 `users.id = auth.uid()`，而 `public.users` 里**还有
一列 `auth_user_id`**。网关自己查的时候必须用同一列，否则两处口径不一致。

### 1.6 用户池边界（已拍板：不隔离）

- 我们只有一个 GoTrue 池。app 的终端用户注册出来的 `auth.users` 行，**就是一个完整的
  TeamClu 平台账号** —— 同一个邮箱可以直接登录 TeamClu 桌面端。
- `auth.users` 上**没有**注册触发器，org 是登录后由 FC 显式调
  `ensure_personal_org` 建的（`supabase-repo.ts:640`）。所以路人注册**不会**凭空长出
  org/team，也**不会**出现在 `public.users` 里 —— 这正是「员工档」能挡住路人的原因
  （见 §4.6）。
- `feature-profiles.ts:78` 已经写明 `POST /rest/v1/rpc/ensure_personal_org` 会绕过注册
  开关，「已知并接受」。

这是当前架构的直接结果，不是本次引入的。已确认接受，记录在此以免日后被当成回归。

### 1.7 这次改表不会撞 pgTAP

`services/supabase/tests/` 里唯一的精确集合断言是
`020_oss_sync_schema.sql:160` 的 `indexes_are('amux', 'amuxc_files', …)`。**没有**针对
`amux.apps` 的 `columns_are` / `indexes_are`。给 `apps` 加列加索引不需要同步改断言。

---

## 2. 目标 / 非目标

**目标**

1. app 打开登录后，未登录访客看到登录页；输入邮箱 → 收验证码 → 进入 app。
2. 该访客被注册进**我们平台的 Supabase**（`auth.users`），与桌面端共用一个用户池。
3. 登录门槛**两档**：
   - **任何登录用户** —— 有我们平台账号即可；
   - **本公司员工** —— 还必须与该 app 所属 team 属于同一个 org。
4. **登录页只有一份**，且跨 app 单点登录：在 A 应用登录过，进 B 应用免登。
5. 登录墙对**三个模板和用户任意代码**一律生效，包括纯静态 app。
6. 用户可以在控制面绑定自己的域名，自助完成 DNS 校验，证书自动签发。
7. 自定义域名上登录与 SSO 照样工作。

**非目标（本轮不做）**

- `third`（第三方 IdP）仍然拒绝部署，行为不变。
- Google / Apple 等社交登录进 app（需要 redirect allow list，见 §7 R3）。
- app 独立用户池 / 独立 Supabase project。
- 按 team、按 per-app 授权名单的更细粒度受众（`app_member_access` 已存在，本轮不接）。
- 域名级访问策略（IP 白名单、地域限制）。
- 部署历史与回滚、环境变量面板。

---

## 3. 关键决策

### D1 · 登录墙做在 FC 代理层，不做在模板里

**这一条偏离了最初讨论的「模板用 supabase-js」形态**，理由是三条实打实的缺陷：

1. app 的代码是 agent 生成、用户随时重写的。墙写在 app 代码里，**一次重写就没了**，
   而控制面仍然显示「已启用登录」。
2. `static-web` 和 `slides` 两个模板是纯静态文件服务器（`server.mjs`）。往里塞
   supabase-js 挡不住对静态资源的直接请求 —— 而 UI 现在就对它们提供登录选项（§1.1）。
3. 墙在代理层 = 用户代码改不坏它，且三个模板 + 任意用户代码 + 自定义域名一次性全部
   覆盖，零模板改动。

**仍然满足「不隔离、共用一个池」**：验证码是 FC 后端调我们 GoTrue 的 `/otp` /
`/verify` 发的，用户确确实实注册进 `auth.users`。同时 `SUPABASE_URL` +
`SUPABASE_ANON_KEY` 照常注入给 app，app 想在自己前端再用 supabase-js 也完全可以。

代价：app 拿不到浏览器里的平台 session（它拿到的是我们透传的身份 header）。对
`data_app` 没有影响 —— 它的数据在自己的 Postgres schema（`DATABASE_URL`），本来就不
经过 Supabase。

### D2 · 用邮箱验证码（OTP），不用 OAuth 2.1，也不用 magic link

依据 §1.3。附带收益：不需要开 GoTrue 的 `OAUTH_SERVER`、不需要
`APP_SECRETS_ENCRYPTION_KEY`、不需要自建 GoTrue OAuth 授权页（GoTrue 只提供
`authorization_path` 配置项，**不提供页面本身**）。

§1.2 的两个线上堵点因此**不需要运维介入**。

### D3 · 会话票据由 FC 自签，密钥从 service role key 派生

FC 容器里没有 `JWT_SECRET`（实测），所以不本地验 GoTrue 的 access token。改为：验证码
校验通过后，FC 签发自己的会话票据；之后每个请求只验自己的签名 —— GoTrue 只在登录那一刻
被调用一次。

密钥取值顺序：`APPS_AUTH_SESSION_SECRET` → 没有则从 `SUPABASE_SERVICE_ROLE_KEY`
HKDF-SHA256 派生（`info="teamclu-apps-auth-v1"`）。

**为什么要有派生兜底**：`APP_SECRETS_ENCRYPTION_KEY` 空着把 `platform` 模式堵死了几个
月，谁都没发现。新功能不能再多一个「不配就静默失效」的必填 env。

### D4 · 复用 `auth_mode = platform`，受众用一列新字段表达

不动 `apps_auth_mode_check` 约束、不动 UI 的三个选项、不动 `deployed_auth_mode` 的
pending 机制。变的是 `platform` 的**实现**（OAuth 2.1 → 代理层 OTP 网关）。

两档门槛用新列 `auth_audience`（`any` | `org`）表达，只在 `auth_mode = 'platform'` 时
有意义。**默认 `org`（收紧）** —— 设计文档 §7「公开性必须显式化」那节的教训是：默认值
必须是保守的那个，放宽要用户显式选。

线上没有任何存量 `platform` app 需要迁移 —— 它从来没跑通过（§1.2）。

### D5 · 自定义域名走我们自己的 Caddy，不走阿里云 FC 的自定义域名

用户域名 CNAME 到我们的盒子 → Caddy on-demand TLS 签证书 → FC 按 Host 查 app → 转发到
函数。理由：

- 走阿里云 FC 绑定要求域名完成 **ICP 备案**，用户域名没有，一律绑不上。
- 我们的代理层已经在做 Host → app 的路由，用户域名只是多一种 Host 形态。
- 登录网关（D1）在代理层，自定义域名自动继承。

⚠️ 备案问题**没有消失**，只是换了位置：用户把域名指向境内 ECS，未备案域名仍可能被
运营商拦截。这一层挡不住，只能在 UI 上给出提示文案（§5.5）。

⚠️⚠️ **这条决策只对 self-host 形态成立。** 产品有两种部署形态，而「走我们自己的 Caddy」
是其中一种独有的能力 —— 另一种形态下自定义域名**不可用**。见 §5.8。

### D6 · 集中的登录服务，用一次性 code 回跳到 app 域名

登录页集中到一个专用域名（`login.<base domain>`）。它带来两件事：登录页只有一份，以及
**跨 app 单点登录**。

但集中登录和自定义域名之间有一个硬冲突：中心域上的 cookie **带不到**
`app.example.com`（跨站）。所以会话不能只放在中心域，必须回跳：中心登录服务签发一个
**一次性 code**，302 回 app 域名，由 app 域名下的网关用 code 换成**该域名自己的**
cookie。

这本质是一个极简 OAuth，但两端都是我们自己的代码，**仍然不需要 GoTrue 的 OAuth
server**。

**形态：Cloud API（`services/fc`）里的一组路由 + 一个专用域名**，不是独立部署单元：

- 它要读 `apps` 表、调 GoTrue、做限流 —— 全是 Cloud API 已有的能力。
- 多一个部署单元 = 多一份 env 要在 `docker-compose.yml` 和 `s.yaml` 两处同步（这个坑
  已经踩过）。
- 没有独立伸缩需求。

⚠️ **绝不能放到阿里云 Function Compute 上**：那上面的函数连不到 compose 网络里的
Postgres 和 GoTrue —— `data_app` 至今不通就是这个原因（`APPS_DB_ADMIN_URL` 被迫留空，
见 `project_selfhost_app_deploy`）。登录服务必须能读 `apps` 表和调 GoTrue。

将来若真要拆成独立服务（故障隔离、被别的产品复用），拆的成本与现在相同 —— 路由边界
就是服务边界。

---

## 4. 设计 A · 登录

### 4.1 三个组件

| 组件 | 住在哪 | 职责 |
|---|---|---|
| **中心登录服务** | `login.<base domain>` → `fc:9000` | 登录页、OTP 收发、中心会话、签发一次性 code |
| **app 域名网关** | 每个 app 的 vanity / 自定义域名（`app.ts` 中间件） | 验 cookie、拿 code 换 cookie、判受众、放行或回跳 |
| **受众判定** | 网关内 | `any` 直接过；`org` 再比一次 org |

### 4.2 请求流

```
① 访客打开 app.example.com/report
   网关：无 cookie
   → 302 https://login.<domain>/?app=<appId>&next=%2Freport&r=<app 域名>

② 中心登录服务
   有中心 cookie？
     是 → 直接签 code
     否 → 登录页 → 邮箱 → GoTrue /otp → 验证码 → GoTrue /verify → 种中心 cookie → 签 code
   → 302 https://app.example.com/__teamclu/auth/callback?code=<一次性>&next=%2Freport

③ app 域名网关
   用 code 换会话（服务端校验：未用过、未过期、aid 匹配、回跳域名匹配）
   → 种该域名自己的 cookie → 302 /report

④ 之后每个请求
   网关验自己的 cookie → 判受众 → proxyToApp（附身份 header）
```

第 ② 步的「有中心 cookie 就直接签 code」就是 SSO：进第二个 app 时用户看不到登录页，只
经历两次瞬时重定向。

### 4.3 中心登录服务端点（`login.<base domain>`）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/` | 登录页；带 `app` / `next` / `r` 参数。有中心会话则直接签 code 并 302 |
| POST | `/otp` | `{email}` → GoTrue `POST /auth/v1/otp`（`create_user: true`）发验证码 |
| POST | `/verify` | `{email, code}` → GoTrue `POST /auth/v1/verify`（`type: "email"`）→ 种中心 cookie → 签 code → 302 |
| POST | `/logout` | 清中心 cookie |

GoTrue 调用走**内网** `SUPABASE_URL`（`http://kong:8000`），不走公网域名。

### 4.4 app 域名网关端点

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/__teamclu/auth/callback` | `?code=…&next=…` → 换会话 → 种 cookie → 302 到 `next` |
| POST | `/__teamclu/auth/logout` | 清本域 cookie → 302 到中心服务的 `/logout` |

前缀用双下划线压低和用户 app 路由撞车的概率。**这两个路径永远由网关处理、永不转发给
app** —— 否则 app 里一个同名路由就能伪造回调。

### 4.5 两种 cookie

| | 中心会话 | app 会话 |
|---|---|---|
| 域 | `login.<base domain>` | 该 app 自己的域名 |
| 名 | `__teamclu_sso` | `__teamclu_app_session` |
| 载荷 | `{ sub, email, exp }` | `{ sub, email, aid, exp }` |
| 有效期 | 30 天 | 7 天，剩余不足 1 天时滑动续期 |
| 属性 | `HttpOnly; Secure; SameSite=Lax; Path=/`（都不设 `Domain`） | 同左 |

**三种票据（含下节的 code）共用一把密钥，靠 JWT 的 `aud` 区分**：`teamclu-apps-sso` /
`teamclu-apps-session` / `teamclu-apps-code`。audience 隔离是承重的，不是装饰：没有它，
从中心域偷到的 SSO cookie 会当作 app 会话验过，而下面那条 `aid` 检查根本无从失败
（SSO 票据没有 `aid`）。

实现用 **JWT（`jose`）而不是手搓 `v1.<payload>.<hmac>`** —— 与
`agent-management-grant.ts` 同一路子。`jose` 已是依赖，常数时间比较和 `exp` 校验都是现成
的；自己写这段密码学代码买不到任何东西，还恰恰是那种「测试发现不了的错」。

校验顺序：签名 → `aud` → `exp` → （app 会话）**`aid` 必须等于当前请求命中的 app id**。
`aid` 这一条不能省：没有它，A 应用的 cookie 在被绑到同一个父域的 B 应用上也能用，而每个
vanity host 都共享 `*.apps.<domain>` 这个父域。`verifyAppSession(token, expectedAppId)`
把 `expectedAppId` 设成**必填参数**，让调用点无法忘记这个检查。

### 4.6 一次性 code

- 载荷：`{ sub, email, aid, redirect, jti, exp }`，`exp` = 60 秒。
- 存一个已用 `jti` 的内存集合（TTL 120 秒），**用过即废**。
- `redirect` 在签发时就写死为该 app 当时登记的域名；网关换取时再比对一次当前 Host。

**回跳地址必须校验是该 app 已登记的域名**（vanity host 或已校验的 `custom_domain`），
否则中心登录服务就是一个 open redirect（R9）。

### 4.7 受众判定

```
auth_audience = 'any'  → 有有效会话即可
auth_audience = 'org'  → 还需 visitorOrgId === appOrgId
```

- `visitorOrgId`：`public.users.org_id where id = <会话 sub>`。
  **匹配 `users.id`，不是 `auth_user_id`** —— 与 `amux.current_org_id()` 保持同一口径
  （§1.5）。查不到行 → 无 org → 拒绝。
- `appOrgId`：`teams.oid where id = apps.team_id`（`resolveTeamOrgId`）。
  **不读 `apps.org_id`** —— 静态 app 那列是 null。

两个 fail-closed 的边界，都要在 UI 上说清楚：

1. **路人注册进来的账号在 `public.users` 里没有行**（§1.6），所以 `org` 档下必然被拒。
   这正是「员工」这一档要的效果。
2. **`teams.oid` 为空的 team，其 app 在 `org` 档下谁都进不去。** 保存 `auth_audience =
   'org'` 时就要检查并直接报错，不能等到访客被挡在门外才发现。

判定结果按 `(appId, userId)` 缓存 60 秒，避免每个静态资源请求都查两次库。

### 4.8 数据库

```sql
alter table amux.apps
  add column if not exists auth_audience text not null default 'org';

alter table amux.apps
  drop constraint if exists apps_auth_audience_check;
alter table amux.apps
  add constraint apps_auth_audience_check check (auth_audience in ('any', 'org'));
```

默认 `org` 是有意的收紧（D4）。`APP_COLUMNS`（`supabase-repo/shared.ts:107`）追加该列。

**⚠️ 实现时修正了这一节。** 原文说「受众立即生效、登录方式仍需重新部署」——后半句是错的。
墙在代理层读的是 `apps.auth_mode`，不是 `deployed_auth_mode`，所以**开关登录同样立即生效**：
用户一打开登录，下一个请求就被拦。这是 D1 白送的、也是更安全的行为——原方案会让一个刚
标记为「需要登录」的 app 继续裸奔到下次部署为止。

`deployed_auth_mode` 因此换了含义：它不再表示「墙有没有生效」，只表示**函数 env 有没有跟上**
（§4.9 那几个变量）。UI 上的「待重新部署」提示要相应改写——现在它的意思是「app 自己的代码
还拿不到 SUPABASE_URL」，而不是「站点还没有登录墙」。

### 4.9 注入给函数的 env

`buildPlatformOAuthEnv` → `buildPlatformAuthEnv`，返回：

```
APP_PUBLIC_URL      # 不变，app 的对外地址
API_BASE            # 不变
SUPABASE_URL        # 新：取 SUPABASE_PUBLIC_URL（浏览器可达，不是 kong 内网地址）
SUPABASE_ANON_KEY   # 新
```

不再返回 `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET`，`applyAuthModeChange` 不再调 GoTrue
注册客户端、不再写 `app_secrets`。切到 `platform` 变成纯状态变更，**不会再因为
`APP_SECRETS_ENCRYPTION_KEY` 为空而失败**。

存量清理：切走时若 `oauth_client_id` 非空仍尝试回收一次（best-effort，失败只记日志）。

### 4.10 透传给 app 的身份

代理放行时追加请求头：

```
X-Teamclu-User-Id:    <auth.users.id>
X-Teamclu-User-Email: <email>
X-Teamclu-Org-Id:     <visitorOrgId，无则省略>
```

**必须先删除客户端同名请求头再写入**，否则任何人都能伪造身份。这条写进代码注释。

### 4.11 限流

`/otp` 是发信端点，不限流就是发信炸弹。复用 `lib/rate-limit.ts` 的 `isRateLimited`，
按 `resolveClientIp` + 邮箱组合 key，配额比默认更紧（建议 5 次/分钟）。

注意：vanity 中间件注册在全局限流器**之前**（`app.ts` 的注释解释了为什么 —— app 的页面
加载不该记在 API 预算里），所以中心登录服务与网关都必须自己限流。

### 4.12 失败模式

| 情况 | 行为 |
|---|---|
| GoTrue 不可达 | 登录页显示「登录服务暂时不可用」，**不放行** |
| 验证码错误/过期 | 登录页回显错误，保留邮箱 |
| cookie 签名不对 / 过期 / `aid` 不匹配 | 当作未登录，回跳中心登录 |
| code 已用过 / 过期 / `redirect` 对不上 | 回跳中心登录重来，**不报细节** |
| `org` 档但访客不在同一 org | 403 页面：「你的账号不属于该应用所在的组织」+ 换账号入口。**不是 404** —— 人已登录，含糊其辞只会让人反复重试 |
| `org` 档但 `teams.oid` 为空 | 保存时就拒绝（§4.7），不该跑到这里 |
| app 未部署 | 保持现状 404，**不显示登录页**（不泄露 app 是否存在） |

### 4.13 路径级门槛（批次 3.5 追加）

原方案把登录当成 app 级的开关。真实的 app 不是：产品的落地页要公开而 `/app` 要登录，
文档站人人可读而编辑不行。只有「整站」和「不管」两个选项时，用户只能选错。

于是有了**第三个正交维度**：

| 维度 | 列 | 值 |
|---|---|---|
| 有没有墙 | `auth_mode` | none / platform / third |
| **墙拦哪些路径** | **`auth_scope` + `auth_rules`** | **all / paths + 例外表** |
| 谁能过墙 | `auth_audience` | any / org |

**基线 + 例外，最长前缀胜出**：

```
scope=all,   rules=[]                                    全站需要登录（默认）
scope=all,   rules=[{/health, public}]                   全站登录，放行 /health
scope=paths, rules=[{/admin, required}]                  只有 /admin 需要登录
scope=paths, rules=[{/api, required},
                    {/api/webhook, public}]              保护 /api，放行 webhook
```

最长前缀而非列表顺序：规则集因此是**声明式**的，没人需要从上往下读一遍才知道某个 URL 落
在哪条上。路由表是同样的道理。

**匹配用前缀，不用 glob。** 人实际会写的规则全是前缀（`/admin`、`/api`、`/_serverFn`）；
`*`/`**` 要解释跨不跨斜杠，换来的灵活性没人用，而读错 glob 的失败方向恰恰是「我以为这
里保护了」。但**尾部的 `/*` 要接受**——那是人会打出来的写法，纯前缀语义下它会去匹配字面
量路径 `/admin/*`，什么都保护不到而且不报错。所以 API 把尾部 `*` 剥掉并提示，`*` 出现在
别处则直接拒绝。

**三处 fail closed**：
- 路径里带 `%2f`/`%5c`/`%2e` 或 `..`/`.` 段 → 直接要求登录。`URL.pathname` 会解析
  `..` 但**不解码 `%2F`**，而 app 自己解码的话就会服务一个我们的前缀检查从没见过的路径。
- 规则集里有任何一条读不懂 → 整个规则集作废、全站要求登录。坏规则绝不能成为「某个受保护
  路径变得可达」的原因。
- `scope=paths` 但没有任何 `required` 规则 → **保存时 400**。否则控制面写着「需要登录」
  而每个 URL 都是公开的。

**身份透传的语义收紧了**：公开路径上也带 `X-Teamclu-User-*`，但**仅当这个访客本来也够格
进这个 app**（受众校验通过）。这样这个 header 在任何地方都只有一个含义——「此人满足进入
本应用的全部条件」。落地页因此能显示「欢迎回来」，而一个 org 对不上的人在公开页上仍然是
匿名的。

---

---

## 5. 设计 B · 自定义域名

### 5.1 数据库

新迁移 `services/supabase/migrations/20260908000000_apps_custom_domain.sql`（与 §4.8 的
`auth_audience` 合并成一个迁移文件）：

```sql
alter table amux.apps
  add column if not exists custom_domain text,
  add column if not exists custom_domain_token text,
  add column if not exists custom_domain_verified_at timestamptz;

-- 一个域名只能属于一个 app。部分索引：未绑定的行不参与。
create unique index if not exists apps_custom_domain_uniq
  on amux.apps (lower(custom_domain)) where custom_domain is not null;
```

RLS 沿用 `apps` 表现有策略，新列自动受保护。§1.7 已确认不撞 pgTAP。

### 5.2 API（先进 `docs/openapi/teamclu-api.v1.yaml`，按 CLAUDE.md 的顺序）

| 方法 | 路径 | 作用 |
|---|---|---|
| PUT | `/v1/apps/:appId/custom-domain` | `{domain}` → 校验格式、写入、生成 token、清空 `verified_at`，返回要加的 DNS 记录 |
| POST | `/v1/apps/:appId/custom-domain/verify` | 真查 DNS，通过则写 `verified_at` |
| DELETE | `/v1/apps/:appId/custom-domain` | 解绑，三列清空 |

`auth_audience` 走已有的 `PATCH /v1/apps/:appId`，不新增端点。

写权限与 `updateApp` 一致（creator 或 app admin）。注意 `apps_update_if_creator` 是
creator-only 的 RLS，`updateApp` 已有
`writer = callerIsCreator ? supabase : serviceRoleClient` 的绕法
（`supabase-repo.ts:3261-3267`）—— **新方法必须跟上这个写法**，否则 admin 授权者绑定域名
会静默 404。这正是 apps 审计里 P0-2 的同一个坑。

### 5.3 校验流程

用户拿到两条记录：

```
CNAME  app.example.com          →  <slug>-<id8>.apps.teamclu-dev.ucar.cc
TXT    _teamclu.app.example.com →  teamclu-verify=<token>
```

`verify` 端点用 `node:dns/promises` 查 TXT，命中 token 即通过。**用 TXT 而不是只看
CNAME**：CNAME 生效前用户就想点验证，而 TXT 可以独立先加；且 CNAME 在 apex 域名上不合法，
TXT 没这个限制。

拿到 `verified_at` 之后，域名才对 `ask` 和代理可见。**未校验的域名一律不签证书** ——
这是 `ask` 闸门存在的全部意义（Let's Encrypt 的限额按注册域名计，和
api/supabase/mqtt 共享）。

### 5.4 代理与闸门

- `apps-vanity.ts`：`VanityApp` 加 `authMode`、`authAudience`、`teamId`、`customDomain`；
  lookup 增加一条「按 `lower(custom_domain) = host` 且
  `custom_domain_verified_at is not null`」的查询路径。
- `app.ts:77` 的 `ask`：现在第一行是 `if (!parseAppPublicHost(domain)) return 404`，
  要放宽成「vanity host **或** 已校验的自定义域名」。
- `app.ts:85` 的中间件：同样放宽。
- 复用已有的查找缓存（命中 30s / 未命中 5s），自定义域名走同一套。

### 5.5 Caddy

两个新站点块。中心登录服务：

```
{$CADDY_SITE_SCHEME}{$LOGIN_DOMAIN} {
	{$CADDY_SITE_TLS}
	reverse_proxy fc:9000
}
```

用户域名的 catch-all，放在**文件最末**：

```
# 用户自己绑的域名。必须放在最后 —— 它匹配一切前面没接住的 Host。
# 证书仍由全局 on_demand_tls 的 ask 闸门守着：未校验的域名 FC 答 404，
# Caddy 直接拒绝握手，不会去 Let's Encrypt 要证书。
:443 {
	tls {
		on_demand
	}
	reverse_proxy fc:9000
}
```

顺序敏感：catch-all 必须在 `*.{$APPS_DOMAIN}` 与 `$LOGIN_DOMAIN` 之后。

### 5.6 生命周期

- 删 app：`app-delete.ts` 的清理里一并清空三列（该文件已有 `deleteCustomDomain` 漏绑
  `makeTeardownAppDeps` 的历史问题，动这里时顺手核对一下绑定完整）。
- 换域名：直接 PUT 新值，旧值失效；证书留在 Caddy 里自然过期，无需处理。
- app 下线（`fc_status != 'live'`）：`isServable` 已经挡住，自定义域名走同一个判断。

### 5.7 前端

`AppControlPanel.tsx:718-738` 的占位换成真实表单：输入 → 保存 → 显示两条 DNS 记录
（带复制按钮）→「我已添加，去校验」按钮 → 状态徽章（待校验 / 已生效 / 校验失败）→ 解绑。
文案里点明备案提示（D5）。

登录方式那一块加受众选择器（「任何登录用户」/「本公司员工」）。**开关登录和改受众都立即
生效**（§4.8），所以不需要「待重新部署」提示；那个提示改为只在函数 env 落后时出现，文案
说明的是「应用代码还拿不到 Supabase 配置」。`teams.oid` 为空时禁用「本公司员工」并给出原因。

新增 locale key 走文本编辑，**不要 parse-and-dump**（会炸重复 key 守卫）。

### 5.8 两种部署形态，只有一种能做自定义域名

`services/fc` 从同一份源码发到两个目标（CLAUDE.md 的「Deployment」一节），而这两个目标的
**入口层完全不同**。本方案的自定义域名整套机制建立在入口层可以接受任意 Host 之上，所以它
只在其中一种形态下成立。

| | **self-host（容器）** | **阿里云 Function Compute** |
|---|---|---|
| 入口 | Caddy | FC 网关 |
| 配置 | `deploy/self-host/caddy/Caddyfile` | FC 自定义域名（手工绑） |
| vanity 域 `*.<APPS_PUBLIC_DOMAIN>` | Caddy 站点块 + on-demand TLS | **一条 FC wildcard 自定义域名**，证书是**手工上传的 PEM 快照**（`services/fc/bind-apps-domain-cert.mjs`，Let's Encrypt 三个月一换，且 **FC 只收 RSA**） |
| 任意 Host 能否进来 | 能 —— catch-all `{$CADDY_CATCHALL_SITE}` | **不能** |

**为什么 FC 形态下进不来**：在 FC 上，一个 Host 要被路由到函数，必须先为它创建一条自定义
域名配置 —— 这不是推断，我们自己的代码就是这么做的（`fc-client.ts:265`
`ensureCustomDomain` 为**每一个 app 函数**单独 `createCustomDomain`）。用户把
`shop.example.com` CNAME 过来之后，DNS 确实解析到 FC 的入口，但那个 Host 没有对应的配置，
请求在到达我们的代码之前就被网关拒绝了。

**要在 FC 形态下支持自定义域名，需要**（本轮不做）：

1. 绑定时为每个用户域名调一次 `createCustomDomain`；
2. 为它准备证书 —— FC 不签证书，只接受上传的 PEM，所以还要接一套签发与续期
   （`bind-apps-domain-cert.mjs` 目前是人工跑的脚本）；
3. 域名完成 **ICP 备案** —— 这是硬门槛，而用户的域名恰恰通常没有。

第 3 条正是 D5 一开始就不走 FC 自定义域名的原因。换句话说：**这个功能不是"FC 形态下还没
接"，而是"FC 形态下做不了"**，除非把备案这一步转嫁给用户。

**登录服务（`LOGIN_DOMAIN`）也受同一约束**，但它是可解的：那是**一个固定域名**，运维绑一
次 FC 自定义域名 + 上传一次证书即可，不需要 per-app 的动态绑定，备案也由我们自己完成。也
就是说 **§4 的登录墙在两种形态下都能用，§5 的自定义域名只有 self-host 能用**。

**代码层面的表现**：FC 形态下 `apps-vanity.ts` 的自定义域名查找路径永远查不到东西（没有
请求会带着用户域名到达），`/internal/caddy/ask` 也没有调用方（那是 Caddy 才有的闸门）。
两者都是死代码而非故障，不需要额外的开关。

---

---

## 6. 变更清单

### 云端 `services/fc`
- 新增 `src/lib/apps-auth-session.ts` — 票据/code 签发与校验、密钥派生
- 新增 `src/lib/apps-login-service.ts` — 中心登录服务的四个端点 + 登录页
- 新增 `src/lib/apps-auth-gate.ts` — app 域名网关：验 cookie、换 code、判受众
- 新增 `src/lib/apps-custom-domain.ts` — 域名格式校验、token 生成、DNS 查询
- 改 `src/app.ts` — 中心登录服务按 Host 分流；网关接入；`ask` 与中间件放宽
- 改 `src/lib/apps-vanity.ts` — `VanityApp` 加字段；新增按自定义域名查找
- 改 `src/lib/provisioning/app-auth-mode.ts` — 见 §4.9
- 改 `src/lib/provisioning/app-deploy.ts` — `platformOAuthEnv` → `platformAuthEnv`
- 改 `src/lib/supabase-repo.ts` + `supabase-repo/shared.ts` — `APP_COLUMNS`、域名三方法、
  org 解析
- 改 `src/lib/routes/apps.ts` — 三个新路由
- 改 `src/lib/repository-contract.ts` — 契约测试

### 数据库
- 新增 `services/supabase/migrations/20260908000000_apps_auth_audience_and_custom_domain.sql`

### 部署
- 改 `deploy/self-host/caddy/Caddyfile` — 登录域站点块 + catch-all 块
- 改 `deploy/self-host/docker-compose.yml` — `fc` 段补 `APPS_AUTH_SESSION_SECRET`（可空）、
  `LOGIN_DOMAIN`；`caddy` 段补 `LOGIN_DOMAIN`
- 改 `services/fc/s.yaml` — **同一批变量必须同时进这两处**，否则一个目标上静默缺失
- `bootstrap/gen-secrets.sh` — 从 `FC_DOMAIN` 推导 `LOGIN_DOMAIN` 默认值

### 前端
- 改 `packages/app/src/components/apps/AppControlPanel.tsx` — 受众选择器 + 域名表单
- 改 `packages/app/src/stores/apps-store.ts`、`lib/backend/types.ts`、
  `lib/backend/cloud-api/apps.ts`
- 改 locale（中英）

### 契约
- 改 `docs/openapi/teamclu-api.v1.yaml`

### 模板
- 改 `templates/tanstack-postgres/src/lib/platform-auth.ts` — 把 PKCE stub 换成
  「读网关透传的身份 header」的说明与 helper
- 改三个模板的 `AGENTS.md` — 说明登录由平台代理提供，app 不用自己实现

---

## 7. 风险与坑

| # | 风险 | 处理 |
|---|---|---|
| R1 | catch-all Caddy 块吃掉所有未匹配 Host | 必须放文件最末；`ask` 闸门保证未校验域名拿不到证书 |
| R2 | 身份 header 伪造 | 转发前无条件删除客户端的 `X-Teamclu-*` 再写入 |
| R3 | 社交登录（Google）在 app 域名上不可用 | 本轮非目标；要做需给 allow list 加 `https://*.apps.<domain>/**`，且**自定义域名做不到**（不可预知） |
| R4 | 验证邮件是 TeamClu 的模板和发信域名 | 「不隔离」的必然结果，UI 文案讲清楚 |
| R5 | OTP 端点被刷 | §4.11 限流；GoTrue 侧本身也有发信限流 |
| R6 | admin 授权者绑域名 404 | §5.2 必须复用 `updateApp` 的 service-role 绕法 |
| R7 | 备案 | §5.5 D5，只能给提示 |
| R8 | `services/fc` 不在 pnpm workspace，CI 也不跑它的单测 | 本地 `npm ci && npm test`，别指望 CI 兜底 |
| **R9** | **中心登录服务是 open redirect** | 回跳地址必须比对该 app 已登记的域名（§4.6），签发时写死 + 换取时再比一次 |
| **R10** | **`teams.oid` 为空 → `org` 档谁都进不去** | 保存时校验并报错（§4.7），不留到运行时 |
| **R11** | **code 重放** | 一次性 `jti` + 60 秒有效期；多实例部署时内存集合不共享，需降级为「短 TTL + 单实例」或落库 |
| **R12** | **`public.users` 与 `auth.users` 的 id 口径** | 统一用 `users.id = auth.uid()`，与 `current_org_id()` 一致（§1.5） |
| **R14** | **查找缓存是进程内的** | 多实例部署时，一个实例上的绑定变更不会立刻反映到别的实例；未命中 10s 的 TTL 是那些实例的上限。self-host 是单实例，够用；将来要拆多实例得换共享缓存或接受 10 秒延迟 |
| **R15** | **每个请求都要查一次库（首次）** | 自定义域名让 host 无法靠解析排除。缓存把稳态代价压到「每 host 每 10 秒一次」，但冷启动后的第一个 API 请求会多一次查询 |
| **R13** | **路径保护挡不住客户端路由** | 代理只看得见真实 HTTP 请求。TanStack Start 首屏是 SSR（拦得住），但站内点链接过去是客户端路由，代理看不到那次导航，页面外壳会渲染出来。**数据端点必须一并列进保护路径**（该模板是 `/_serverFn/*`）。一句话：路径保护挡的是「谁能拿到这个 URL 的响应」，不是「谁能看到这个界面」；对纯静态模板两者等价，对 SSR+客户端路由的应用只有前者成立。真正的数据边界永远是 app 自己的查询层，代理层是纵深防御的外层。UI 上必须说明 |

---

## 8. 实施顺序

分五个可独立验证的批次：

1. ~~**批次 1 — 会话与 code 原语**~~ ✅ **已完成**（`src/lib/apps-auth-session.ts` +
   `test/apps-auth-session.test.ts`，24 个用例）。验收全部达成，另加了两项设计断言：
   「失败的兑换不烧 code」（校验顺序）与「三种票据不可互换」（audience 隔离）。
   两处变异检验确认测试非假绿：去掉 `aid` 绑定 → 红；把 `jti` 标记提到校验之前 → 红。
2. ~~**批次 2 — 中心登录服务**~~ ✅ **已完成**（`src/lib/apps-login-service.ts`，24 个用例）。
   顺带把 `LOGIN_DOMAIN` / `APPS_AUTH_SESSION_SECRET` 在 compose、`s.yaml`、`.env.example`
   三处声明齐，并加了 Caddy 的登录站点块 —— env 少加一处会静默失效，留到批次 5 太容易漏。
   两处变异检验：放开返回地址校验 → 红；身份改用用户输入的邮箱而非 GoTrue 的回答 → 红。
   用真 Caddy 容器验证了配置有效，并确认 `LOGIN_DOMAIN` 留空会让 Caddy 拒绝启动
   （`server block without any key is global configuration`）—— compose 里的
   `login.localhost` 兜底是必需的，不是冗余。

   **实现记的一条**：`services/fc` 是 `strict: false`，**没有 `strictNullChecks` 就没有
   可辨识联合窄化** —— `if (!result.ok)` 之后访问分支独有字段会编译失败。这里改用了「所有
   字段恒在的扁平结构」。全量测试是绿的而 typecheck 是红的，别只跑测试就下结论。
3. ~~**批次 3 — app 域名网关**~~ ✅ **已完成**（`apps-auth-gate.ts` 21 个用例 +
   `auth_audience` 迁移 + `app-auth-mode.ts` 改造）。四条验收全部达成。三处变异检验：
   未设置受众读作 `any` → 红；不删客户端伪造的身份头 → 红；登录域缺失时放行 → 红。

   **实现时的四处调整**：
   - **墙读 `auth_mode`，开关登录立即生效**（见 §4.8 的修正块）。
   - `verifyAppSession` 补上返回 `expiresAt` —— 批次 1 有 `shouldRenew` 却拿不到过期时间，
     是接口漏了一块。
   - `buildPlatformAuthEnv` **只认 `SUPABASE_PUBLIC_URL`**，没有就不注入 `SUPABASE_URL`。
     `SUPABASE_URL` 在盒子上是 `http://kong:8000`，注给部署在阿里云 FC 上的函数是个必然
     失败的地址，不如不给、让 app 能检测到功能不可用。
   - 中心登录服务的 **`GET /logout` 也真的清 cookie**。网关用 302 把访客送过去，302 必然是
     GET；只清 app cookie 而留着 SSO 的话，下一个请求立刻又被签回去 —— 那是一个看得见地
     什么都没做的退出按钮。代价是可被伪造的 GET 强制登出，是骚扰不是漏洞。
   - 共享的页面外壳提到了 `apps-auth-page.ts`：登录页、验证码页、无权访问页跨两个域名但
     是同一段体验，两份 CSS 一定会漂移。
3.5. ~~**批次 3.5 — 路径级门槛**~~ ✅ **已完成**（`apps-auth-paths.ts` 20 个用例 +
   网关 8 个用例 + `auth_scope`/`auth_rules` 迁移 + `updateApp` 校验接入）。见 §4.13。
   三处变异检验：第一个匹配胜出而非最长前缀 → 红（一次打红三个用例）；坏规则跳过而非
   全体 fail closed → 红；公开路径也透传被拒用户的身份 → 红。契约测试
   `mapApp exposes exactly the canonical keys` 如期抓到了 API 形状变化。
   **UI 留在批次 5**；此刻规则通过 `PATCH /v1/apps/:appId` 配置。

4. ~~**批次 4 — 自定义域名**~~ ✅ **已完成**（`apps-custom-domain.ts` 17 个用例 +
   vanity 4 个 + 网关 4 个 + 迁移 + 三个路由 + OpenAPI）。验收达成。三处变异检验：
   查询不过滤未校验域名 → 红；不拒绝本部署自己的域名 → 红；origin 不跟随请求 host → 红。

   **实现时多出来的四件事**（方案没写，但不做就是错的）：
   - **保留域名**：必须拒绝绑定本部署自己的主机名，否则有人绑 `api.<我们的域名>`
     就能让证书闸门为我们自己的 API 名字签一张证书。列表从 env 读（`APPS_PUBLIC_DOMAIN`
     / `APPS_FC_ROUTE_DOMAIN` / `LOGIN_DOMAIN` / `SUPABASE_PUBLIC_URL` /
     `API_EXTERNAL_URL` / `SITE_URL`），另加 `APPS_RESERVED_DOMAINS` 兜住这个进程看不到
     的名字（Studio、EMQX 只在 Caddy 的 env 里）。
   - **查找缓存**：自定义域名让「靠解析判断这不是 app 域名」这条捷径彻底消失 —— 任意域名
     只能靠查库排除，于是 **Cloud API 自己的每个请求前面都会多一次查询**。缓存命中 30s、
     未命中 10s（未命中才是常态），绑定变化时主动失效。原来有个测试专门断言「非 app 域名
     不构建数据库客户端」，那条契约已经不可能成立，改成了「问一次，然后记住」。
   - **分级错误处理**：既然每个请求都查库，Supabase 没配好就会让整个 API 500。改成
     vanity 形状的 host 出错照旧上抛（数据库抖动不能伪装成「app 被删了」），其他 host
     出错就当作「不是 app」放行给 API。
   - **Caddy catch-all 的地址要变量化**：写死 `:443` 在 `CADDY_TLS_MODE=off` 时**照样绑
     443**（用 `caddy adapt` 实测：HEAD 只绑 `:80`，加了字面量 `:443` 之后多绑一个），
     正是 `CADDY_SITE_SCHEME` 那条注释警告的 Podman 端口映射坑。改用
     `CADDY_CATCHALL_SITE`，`gen-secrets.sh` 在 TLS off 时指向一个 http:// 占位。
5. **批次 5 — 部署配置与前端**：Caddyfile 两个块 + compose/s.yaml env + 控制面表单 +
   locale + 模板文档。验收：线上真绑一个测试域名，证书自动签出、登录墙生效、
   第二个 app 免登。

1 → 2 → 3 是一条链；4 可与 1-3 并行；5 依赖全部。

---

## 9. 已定事项

| 问题 | 结论 | 日期 |
|---|---|---|
| app 用户与平台账号是否隔离 | **不隔离**，共用一个 GoTrue 池 | 2026-09-08 |
| 自定义域名做到什么程度 | **自助绑定 + DNS 校验** | 2026-09-08 |
| 「员工」按 org 还是 team | **按 org**（`public.users.org_id` == `teams.oid`） | 2026-09-08 |
| 集中登录的形态 | **Cloud API 路由 + 专用域名**，非独立部署单元 | 2026-09-08 |
| 静态 app 是否放开登录 | **放开** —— UI 本来就对三种类型都显示登录选项（§1.1），代理层网关让它名副其实 | 2026-09-08 |

---

## 10. 附：本方案不需要的东西

明确记下来，避免日后有人「顺手补上」：

- ❌ GoTrue 的 `OAUTH_SERVER` 开关
- ❌ `APP_SECRETS_ENCRYPTION_KEY`
- ❌ 自建 GoTrue OAuth 授权页
- ❌ 每 app 一个 OAuth client（`oauth_client_id` 列保留但不再写入）
- ❌ `GOTRUE_URI_ALLOW_LIST` 改动
- ❌ 阿里云 FC 自定义域名 / CAS 证书
- ❌ 独立部署的登录服务容器（D6：将来要拆，成本相同）
