# Enterprise IM sign-in (WeCom first)

Status: implemented for WeCom (Cloud API + desktop). DingTalk and Feishu reuse
the same tables, routes and client path with a new provider adapter.

## What it does

An optional sign-in method, switched per deployment like Google:

- **Feature flag** `auth.wecom` (`services/fc/src/lib/feature-profiles.ts`,
  overridable through `APP_FEATURES_JSON`) shows the "使用企业微信登录"
  button. Off in every profile today.
- **Env** `WECOM_*` (`services/fc/src/lib/sso/from-env.ts`) configures the
  provider. Without it the routes answer 501 even if the flag is on.

Product rules (decided 2026-11-26):

1. **Service-provider app (服务商 / 第三方应用) only.** A customer's self-built
   app would need a trusted domain filed (ICP) under the customer's company,
   which our API domain never is.
2. **A company binds to an org; a scan auto-joins that org.** An org
   owner/admin starts the binding from Settings → 组织角色 → 企业微信登录.
   A WeCom admin of the company finishes it by installing the TeamClu app in
   the browser. After that, any member of the company who scans signs in as a
   member identity (admin_type 2) of that org, created on first scan. Scans
   from a company that is not bound are refused with `org_not_connected`.

Binding happens at install time on purpose. Only a WeCom admin can install a
third-party app, so an ordinary employee cannot bind their company to an org
they created (and so cannot collect their colleagues' first sign-ins).

## Flows

Login uses PKCE and the desktop's existing loopback listener, the same as
Google:

```
client                         FC                                   WeCom
  │ GET /v1/auth/sso/wecom/authorize?redirect=<loopback>&code_challenge
  │──────────────────────────────▶ sso_flows(login) ──302──▶ wwlogin/sso/login
  │                                                     (login_type=ServiceApp)
  │                               GET /v1/auth/sso/wecom/callback?code&state
  │                               ◀──────────────────────────────────────────
  │                               getuserinfo3rd → corpid + open_userid
  │                               ensure_sso_identity → user in bound org
  │ ◀──302 <loopback>?code=<one-time>
  │ POST /v1/auth/sso/exchange {code, codeVerifier}
  │──────────────────────────────▶ PKCE check → sso_mint_session → GoTrue refresh
  │ ◀── GoTrue session (same shape as /v1/auth/oauth/exchange)
```

The client redirect must be loopback http or an app scheme (`teamclu*`, plus
`SSO_ALLOWED_REDIRECT_SCHEMES`). A remote redirect would let anyone start a
flow with their own challenge, hand the link to a victim, and receive the code
for the victim's scan.

Binding:

```
admin client: POST /v1/teams/:teamId/sso/wecom/install   (org owner/admin)
  → get_pre_auth_code (+ set_session_info auth_type=1 in test mode)
  → { url: open.work.weixin.qq.com/3rdapp/install?... }   opened in the browser
WeCom admin installs → GET /v1/auth/sso/wecom/install-callback?auth_code&state
  → get_permanent_code → sso_org_bindings(corpid → org)
```

Provider callback (指令回调) `GET|POST /v1/auth/sso/wecom/suite-callback`:
URL verification, `suite_ticket` (stored; needed for every
`suite_access_token`), and `cancel_auth` (deletes the binding).

Data callback (数据回调) `GET|POST /v1/auth/sso/wecom/data-callback`: contact
and user events from each customer company, signed with that company's corpid
as the receiveId. Sign-in uses none of them; the endpoint only verifies the
signature and acknowledges, so the console stops flagging the URL.

## Data (migration `20261126120000_enterprise_sso.sql`)

All service_role only.

| table | key | purpose |
|---|---|---|
| `amux.sso_suite_tickets` | (provider, suite_id) | latest pushed ticket; any FC replica may receive it |
| `amux.sso_org_bindings` | (provider, tenant_id) | corp → org, plus `permanent_code` |
| `amux.sso_identities` | (provider, tenant_id, subject, org_id) | open_userid → auth account, per org |
| `amux.sso_flows` | state | 10-minute login / install state; 2 minutes to exchange after a scan |

`amux.ensure_sso_identity` mints `<id>@teamclu.<provider>` plus a
`public.users` row at admin_type 2. It is INSERT-only, like every identity
path. WeCom gives third-party apps no name, so the nickname defaults to
`企业微信用户 xxxx` until the person renames. `amux.sso_mint_session` only
mints for accounts it linked.

Rebinding a company to another org gives each person a new identity there; the
old identity stays in the old org. A company held by one org cannot be bound
by another until it is disconnected.

## Setting up a deployment

Confirmed against real WeCom on self-host (2026-11-26).

1. In the WeCom provider console (服务商后台), create the third-party web
   app. Set its 指令回调 URL to `<api origin>/v1/auth/sso/wecom/suite-callback`
   and its 数据回调 URL to `<api origin>/v1/auth/sso/wecom/data-callback`.
   Add the egress IP of the Cloud API to the IP whitelist (else 60020). Use a
   test company until the app is published (else -31428 on install).
2. Under 通用配置 → 登录授权, set the trusted domain to the API host and the
   指令回调 URL to the same suite-callback URL. Domain ownership is checked
   with a `WW_verify_<code>.txt` file; list the code in
   `WECOM_DOMAIN_VERIFY_CODES` and FC serves it at the root. The page has its
   own Token / EncodingAESKey; reuse the app's, or set them as
   `WECOM_LOGIN_CALLBACK_TOKEN` / `_AES_KEY`.
3. 登录授权 is a separate suite. Its SuiteID is not shown in the console:
   after 开通并保存, WeCom pushes a `suite_ticket` for it to the callback, and
   the SuiteId is read from `amux.sso_suite_tickets`. Its Secret is separate
   from the app's (the app's gives 40001).
4. Set the env: `WECOM_SUITE_ID` / `_SECRET`, `WECOM_CALLBACK_TOKEN` /
   `_AES_KEY` (the app), `WECOM_LOGIN_SUITE_ID` / `_SECRET` (the 登录授权
   suite; the QR `appid`), the optional `WECOM_LOGIN_CALLBACK_*`,
   `WECOM_PROVIDER_CORPID`, `WECOM_REDIRECT_BASE_URL`,
   `WECOM_DOMAIN_VERIFY_CODES`, and `WECOM_INSTALL_TEST_MODE=1` while the app
   is unpublished. Both deploy targets carry these keys.
5. Wait for the first `suite_ticket` of each suite (刷新Ticket in the
   console forces one). Until then, install and login answer 503.
6. Turn on `auth.wecom` for the deployment.

## Open points

- **Names and avatars.** WeCom gives third-party apps neither: `getuserinfo3rd`
  returns only corpid / userid / open_userid, `user/get` returns the userid as
  `name`, and the old `get_login_info` stopped returning real names in 2020.
  The desktop asks for a display name on first sign-in instead. Real names
  would need a 代开发自建应用 that each customer admin authorizes.
- Desktop only. The browser extension and iOS (custom scheme `teamclu://`
  already passes the redirect check) can follow.
- DingTalk and Feishu: add a provider adapter plus env; the provider column
  check already allows them.
