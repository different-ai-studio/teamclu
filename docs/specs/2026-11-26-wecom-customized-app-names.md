# WeCom member names via a 代开发 app

Status: implemented on `task/gei-teamclu-zeng-jia` (2026-11-27), not yet tried against real WeCom. Follows `2026-11-26-enterprise-im-sso.md`.

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

### Data (migration `20261127090000_sso_directory_apps.sql`)

`amux.sso_directory_apps`, service_role only:

| Column | Notes |
|---|---|
| provider, tenant_id | PK; FK to `sso_org_bindings` (cascade on unbind) |
| auth_corp_id | the corpid WeCom gives the 代开发 app (unique per provider; null = tenant_id). See below |
| permanent_code | the company's 代开发 secret |
| names_granted | last result of `agent/get_permissions` |
| last_checked_at, last_error | why names are not readable yet (not granted, app still 开发中, …) |
| authorized_by | the org admin whose QR link was scanned |

`sso_flows.kind` gains `directory`. Its `state` is 32 hex characters, to
meet WeCom's rule.

RPCs, service_role only:

- `sso_is_placeholder_name(text)`: the one definition of the fallback name.
- `sso_identities_needing_name(provider, tenant_id)`: the company's identities
  still on the placeholder, in their profile or in any team.
- `sso_apply_directory_name(user_id, name)`: replace the placeholder in
  `public.users.nickname` and the member `amux.actors.display_name` rows,
  leaving chosen names alone.

pgTAP: `064_sso_directory_names.sql`.

### Backend (FC, `services/fc/src/lib/sso/`)

- **QR link.** `POST /v1/teams/:teamId/sso/wecom/directory` (org
  owner/admin). It requires the org to have a bound company, calls
  `get_customized_auth_url`, stores a `directory` flow (as long as the link
  lives, at most 10 days), and returns `{ qrcodeUrl, expiresAt }`.
- **Status.** `GET /v1/teams/:teamId/sso/wecom` adds `directoryConfigured`,
  plus `directory: { namesGranted, lastCheckedAt, lastError, createdAt } | null`.
- **Manual re-check.** `POST /v1/teams/:teamId/sso/wecom/directory/sync`
  re-checks the grant and fills placeholders. It returns `{ directory, updated }`,
  or 409 when the company has not authorized.
- **Callbacks.** Messages whose `SuiteId` is the template are answered
  `success` at once; the WeCom calls run in the background, because WeCom
  allows 1000 ms.
  - `create_auth`: exchange the code, then find the bound company the
    returned corpid belongs to (see *Matching corpids*). If `State` (or the
    state echoed by `get_permanent_code`) names a live `directory` flow, only
    that org's binding may match, and the flow's requester is recorded.
    Without a live flow — the admin authorized from the WeCom console, or the
    link expired — any binding may match: only the company's own admin can
    authorize, and the binding already ties the company to its org. No match
    → log and ignore. Then check the grant, and fill names if it is there.
  - `change_auth`: re-check, and fill names if granted.
  - `reset_permanent_code`: exchange the new code, replace the secret,
    re-check. With no stored authorization it is adopted like `create_auth`
    without a flow (a reset from the provider console recovers one that was
    dropped).
  - `cancel_auth`: delete the directory app only. The company keeps signing in.
  - Template callbacks name the company by the 代开发 corpid (`AuthCorpId`),
    so the row is found by `auth_corp_id`.
- **Matching corpids.** A binding made by the sign-in app can hold the
  plaintext corpid (`ww…`) while the 代开发 app gets the encrypted open corpid
  (`wp…`) for the same company — seen on self-host on 2026-11-27, where the
  first authorization was dropped because the two were compared by equality.
  A binding matches when its tenant id equals the 代开发 corpid or
  `service/corpid_to_opencorpid` (provider token) converts it to that corpid.
  The row stays keyed by the binding's tenant id, which identities use;
  `auth_corp_id` is what the 代开发 app's own calls (`gettoken`) use.
  - The template's `suite_ticket` is stored like any other suite's.
- **Company token.** `gettoken(corpid, permanent_code)`, cached per company
  until 5 minutes before expiry; dropped on rotation or cancel.
- **Name fill.** `user/get?userid=<subject>`. A `name` equal to the userid
  means "not revealed" and is skipped. It runs:
  - on each sign-in, in the background, for that person only, while their
    name is a placeholder;
  - after a grant (`create_auth` / `change_auth`), for the whole company;
  - from the manual re-check.

  A lookup failure is logged and never blocks sign-in.
- **Env.** `WECOM_CUSTOMIZED_SUITE_ID` / `_SECRET` and `WECOM_PROVIDER_SECRET`,
  plus `WECOM_PROVIDER_CORPID`. Names are on only when all four are set; a
  partial setup logs an error and leaves them off.
- **Tests.** `sso-wecom.test.ts`, against a fake WeCom.

### Desktop

- Once the company is connected, the 「企业微信登录」 card shows a 「成员姓名」
  step (only where names are configured). It has three states:
  - not authorized: 「获取成员姓名」 shows the QR;
  - authorized but not readable: explains the review and the grant, shows
    `lastError`, and offers 「重新检查」;
  - active: offers 「立即同步」.
- The first-sign-in name prompt is unchanged: it keys on the placeholder name,
  so it stops appearing once a real name lands.

### Per customer company (ops)

1. The company's admin scans the QR from Settings.
2. We submit that company's app for 上线审核 in 服务商后台 and wait.
3. Their admin sets 可见范围 to everyone and approves 「姓名」.

Steps 2 and 3 are the friction; ship a one-page customer guide with this.

## Rollout

1. Ships with #2023 (built on the same branch).
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
