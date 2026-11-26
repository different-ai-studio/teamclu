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

1. In the WeCom provider console (服务商后台), create the third-party app.
   Set its 指令回调 URL to `<api origin>/v1/auth/sso/wecom/suite-callback`,
   and its trusted / 登录授权 domain and install redirect domain to the API
   host. Configure 登录授权 if it is a separate suite.
2. Set `WECOM_SUITE_ID`, `WECOM_SUITE_SECRET`, `WECOM_CALLBACK_TOKEN` and
   `WECOM_CALLBACK_AES_KEY`, plus the optional `WECOM_LOGIN_SUITE_*`,
   `WECOM_PROVIDER_CORPID`, `WECOM_REDIRECT_BASE_URL` and
   `WECOM_INSTALL_TEST_MODE=1` while the app is unpublished. Both deploy
   targets carry these keys.
3. Wait for the first `suite_ticket` (up to 10 minutes after the callback URL
   verifies). Until then, install and login answer 503.
4. Turn on `auth.wecom` for the deployment.

## Open points

- **Not verified against real WeCom yet.** We have no provider registration
  yet. Two items in the docs are ambiguous. First, whether the QR `appid` is
  the 登录授权 SuiteID or the provider CorpID: document 98171 says SuiteID,
  but its own example shows a CorpID. Second, whether the 登录授权 suite gets
  its own `suite_ticket` push. `WECOM_LOGIN_SUITE_*` covers a separate suite;
  the appid is the one that may need changing after the first real test.
- Desktop only. The browser extension and iOS (custom scheme `teamclu://`
  already passes the redirect check) can follow.
- Names: a contact-permission lookup through `permanent_code` could fill in
  real names later.
- DingTalk and Feishu: add a provider adapter plus env; the provider column
  check already allows them.
