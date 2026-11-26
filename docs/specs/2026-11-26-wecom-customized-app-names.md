# WeCom member names via a 代开发 app

Status: proposed (2026-11-26). Follows `2026-11-26-enterprise-im-sso.md`.

## Problem

WeCom sign-in runs through TeamClu's third-party app (第三方应用). WeCom gives
third-party apps neither a member's name nor their avatar:

- `getuserinfo3rd` returns only corpid / userid / open_userid;
- `user/get` returns the userid as `name` (「第三方不可获取」);
- the old `get_login_info` stopped returning real names in 2020.

Accounts therefore start as `企业微信用户 xxxx`, and the desktop asks the person
for a display name on first sign-in. That works, but the names are self-typed
and every member has to do it.

A **代开发自建应用** (provider-developed self-built app) is WeCom's sanctioned
way for a provider to read a company's directory. Once the company's admin
grants 「姓名」, `user/get` returns real names server-side.

## What WeCom's docs establish

Doc ids are under `https://developer.work.weixin.qq.com/document/path/<id>`.

- **IDs line up (97104, 96516).** For companies authorized after 2022-06-28,
  「针对同一服务商名下所有第三方应用和代开发应用获取的加密ID，保持一致」:
  the 代开发 app's corpid and userid equal the third-party app's. For newly
  authorized companies the encrypted userid also equals `open_userid`, which is
  what `amux.sso_identities.subject` stores. So
  `user/get?userid=<subject>` works with no conversion. Encrypted ids are case
  sensitive. (Plaintext ids from pre-2022 installs would need
  `batch/userid_to_openuserid`; TeamClu has none.)
- **Names (98980, 96255, 96259, 96260).** 「姓名」 is a custom permission under
  通讯录管理 → 成员基本信息. With it, `user/get`, `user/list` and
  `user/simplelist` return `name` (「代开发自建应用需要管理员授权才返回」).
  The member must be in the app's 可见范围. The grant can be checked with
  `agent/get_permissions` (`contact:sensitive:user_name`). Avatar, mobile and
  email additionally need each member's own OAuth consent: out of scope.
- **Install (98744, 100965, 97163).**
  - `POST /cgi-bin/service/get_customized_auth_url?provider_access_token=`
    with `{state, templateid_list}` returns a `qrcode_url`. `state` is
    `[a-zA-Z0-9]{1,32}` and the link expires after 10 days.
  - The admin scans it. The template's 指令回调 receives `create_auth` with
    `AuthCode` (valid 10 min) and `State`.
  - `POST /cgi-bin/service/v2/get_permanent_code?suite_access_token=` (template
    suite token) exchanges the code. 「获取到的permanent_code，即为代开发应用的secret」.
    It returns `auth_corp_info.corpid` and `state`, but no access token.
  - There is no browser redirect at the end; completion only arrives by callback.
- **Company token (97164).** Plain
  `GET /cgi-bin/gettoken?corpid=<corpid>&corpsecret=<permanent_code>`, not
  `get_corp_token`.
- **Callbacks (97173, 100965, 97175).** The template's callback gets
  `suite_ticket` (template SuiteID starts with `dk`), `create_auth`,
  `change_auth` (visibility / permission changes), `cancel_auth` (delete the
  company's data) and `reset_permanent_code` (with a new `AuthCode`). Answer
  within 1000 ms.
- **Review (97112).** The template is reviewed once. Then **each company's
  app** goes through its own 上线审核 in our console; until it passes, the app
  stays 「开发中」 and the admin cannot set its 可见范围. Test with a 服务商测试企业.
- **Cost (97176).** 代开发 apps need 接口调用许可 like third-party apps, after a
  90-day trial per company. Sign-in needs the licence anyway. No listing or
  review fee was found.
- **Constraints.** One app per company per template. Providers may not build
  for customers as plain self-built apps (99617), so 代开发 is the only route.

## Design

### Console setup (once)

1. 服务商后台 → 应用管理 → 应用代开发 → 创建代开发应用模版.
2. Callback URL: `<api origin>/v1/auth/sso/wecom/suite-callback`. The suite
   callback already accepts a ticket for any signed SuiteId, so the app's
   Token / EncodingAESKey can be reused.
3. Permissions: 通讯录 → 成员基本信息, plus the custom 「姓名」.
4. Submit the template for review, then put it live.
5. Record the template SuiteID (`dk…`) and Secret, and the provider's
   **ProviderSecret** (`get_customized_auth_url` needs `provider_access_token`).

### Env

| Key | What |
|---|---|
| `WECOM_CUSTOMIZED_SUITE_ID` / `_SECRET` | the 代开发 template |
| `WECOM_PROVIDER_SECRET` | provider secret, for `provider_access_token` |

`WECOM_PROVIDER_CORPID` (already defined) becomes required when the template
is set. Add the keys to the compose `environment:` map, `.env.example` and
`deploy/belayo/cloud-api.env.keys`. Unset template = the feature is off and
the routes answer 501.

### Data (new migration)

`amux.sso_customized_apps`, service_role only:

| Column | Notes |
|---|---|
| provider, tenant_id | PK; FK to `sso_org_bindings` (cascade on unbind) |
| permanent_code | the company's 代开发 secret |
| status | `pending_review` / `live` |
| names_granted | last result of `agent/get_permissions` |
| updated_at | |

`sso_flows.kind` gains `customized`. Its `state` is generated as 32
alphanumeric characters to meet WeCom's rule.

### Backend (FC, `services/fc/src/lib/sso/`)

- **Install link.** `POST /v1/teams/:teamId/sso/wecom/directory-install` (org
  owner/admin). It requires the org to have a bound company, stores a
  `customized` flow, calls `get_customized_auth_url`, and returns
  `{ qrcodeUrl, expiresAt }`.
- **Status.** `GET /v1/teams/:teamId/sso/wecom` adds
  `directory: { status, namesGranted } | null`.
- **Callbacks** (handled in the suite callback):
  - `create_auth` with a `State` that names a `customized` flow: call
    `get_permanent_code` and check that the corpid is the flow org's bound
    company; refuse and log otherwise. Store the row as `pending_review`.
  - `change_auth`: refresh `names_granted`, and mark `live` once
    `agent/get_permissions` succeeds. If names were just granted, run the
    backfill.
  - `reset_permanent_code`: exchange the new `AuthCode` and replace the secret.
  - `cancel_auth` for a template SuiteId: delete the row only, and keep the
    sign-in binding.
- **Company token.** `gettoken(corpid, permanent_code)`, cached per company
  until 5 minutes before expiry.
- **Name fill.** Only a placeholder name is replaced, never one the person
  chose.
  - **On sign-in:** if the identity's nickname is still the placeholder and
    the company has a `live` app with `names_granted`, call `user/get` and set
    the name via a SECURITY DEFINER RPC that updates only while the placeholder
    is in place.
  - **Backfill:** when names are first granted, call `user/simplelist` and fill
    every identity of that company still on the placeholder.
  - **Manual:** a 「从企业微信同步姓名」 action triggers the same backfill.
  - Failures (no grant, member outside 可见范围, no licence) are logged and
    never block sign-in.
- **Tests.** A fake WeCom covering `get_customized_auth_url`,
  `get_permanent_code`, `gettoken`, `user/get` / `simplelist` and
  `get_permissions`. Cases: the state → org mapping, refusing another org's
  company, replacing a placeholder but not a chosen name, and rotation and
  cancel. Plus pgTAP for the table and RPC, and OpenAPI paths.

### Desktop

- The 「连接企业微信」 card gets an optional second step, 「同步成员姓名」.
  It shows the QR from `directory-install` and the status: 未授权 /
  待上线审核 / 已生效 / 未授予姓名权限.
- The first-sign-in name prompt is unchanged: it keys on the placeholder name,
  so it stops appearing once a real name lands.

### Per customer company (ops)

1. The company's admin scans the QR from Settings.
2. We submit that company's app for 上线审核 in 服务商后台 and wait.
3. Their admin sets 可见范围 to everyone and approves 「姓名」.

Steps 2 and 3 are the friction; ship a one-page customer guide with this.

## Rollout

1. Separate PR after #2023 merges.
2. Verify on self-host with the 引力拼图 test company: install, review, grant,
   sign-in fill, backfill.
3. Then the first real customer.

## Open points

- **Shortcut.** Doc 97163 mentions authorizing the 代开发 app from within the
  third-party app (`auth_from_thirdapp`, old doc 37304, needs a developer
  login to read). If it works, admins could skip the separate QR.
- **Unverified until the first real test:**
  - how long each company's 上线审核 takes;
  - whether template calls also go through the provider IP whitelist (97165's
    section on it is empty);
  - whose ICP subject the 代开发 trusted domain must match. That only matters
    for OAuth / JSSDK, which this design does not use.
- **Name precedence.** Default: a WeCom name only replaces the placeholder. If
  the product wants WeCom to always win (a directory-managed name), add a
  per-org setting.
