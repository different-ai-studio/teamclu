// WeCom service-provider (第三方应用) API calls used by enterprise sign-in.
//
// All of them hang off a suite_access_token, which WeCom only issues against
// the suite_ticket it pushes to our callback URL every ten minutes (see
// sso-service.ts handleSuiteCallback). Tokens live two hours; we cache them
// per FC process and refresh five minutes early.
//
// Docs (developer.work.weixin.qq.com):
//   get_suite_token     document/path/90600
//   getuserinfo3rd      document/path/98179  (Web 登录, login_type=ServiceApp)
//   get_pre_auth_code   document/path/90601
//   set_session_info    document/path/90602
//   get_permanent_code  document/path/90603
//
// 代开发 (provider-developed self-built app), for member names
// (docs/specs/2026-11-26-wecom-customized-app-names.md):
//   get_provider_token          document/path/91200
//   get_customized_auth_url     document/path/98744
//   v2/get_permanent_code       document/path/97163
//   gettoken (corpsecret = permanent_code)  document/path/97164
//   agent/get_permissions       document/path/99108
//   user/get                    document/path/96255
import { ApiError } from "../http-utils.js";

const API = "https://qyapi.weixin.qq.com/cgi-bin";

export interface WecomSuite {
  suiteId: string;
  suiteSecret: string;
}

export interface WecomLoginIdentity {
  corpId: string;
  /** Stable per service provider across its apps (document/path/98179). */
  openUserId: string;
  /** Plain or ciphertext userid, depending on the corp's authorization. */
  userId: string | null;
}

export interface WecomPermanentAuth {
  permanentCode: string;
  corpId: string;
  corpName: string | null;
  installerOpenUserId: string | null;
}

export interface WecomDirectoryAuth {
  permanentCode: string;
  corpId: string;
  corpName: string | null;
  /** The `state` given to get_customized_auth_url, when WeCom echoes it. */
  state: string | null;
}

/** The permission that makes user/get return real names to a 代开发 app. */
export const WECOM_NAME_PERMISSION = "contact:sensitive:user_name";

export interface WecomClientDeps {
  fetchImpl?: typeof fetch;
  /** The latest suite_ticket for this suite (amux.sso_suite_tickets). */
  loadSuiteTicket: (suiteId: string) => Promise<string | null>;
  nowMs?: () => number;
}

async function call(fetchImpl: typeof fetch, url: string, init: RequestInit | undefined, what: string) {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (e) {
    throw new ApiError(502, "upstream_unavailable", `WeCom ${what} unreachable: ${(e as Error)?.message ?? e}`);
  }
  let body: any;
  try {
    body = await res.json();
  } catch {
    throw new ApiError(502, "upstream_unavailable", `WeCom ${what} returned HTTP ${res.status} without JSON`);
  }
  if (!res.ok || (body?.errcode ?? 0) !== 0) {
    throw new WecomApiError(what, Number(body?.errcode ?? res.status), String(body?.errmsg ?? ""));
  }
  return body;
}

export class WecomApiError extends ApiError {
  constructor(public what: string, public errcode: number, errmsg: string) {
    super(502, "upstream_error", `WeCom ${what} failed: ${errcode} ${errmsg}`.trim());
  }
}

export function createWecomClient(deps: WecomClientDeps) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const nowMs = deps.nowMs ?? (() => Date.now());
  const tokens = new Map<string, { token: string; expiresAt: number }>();

  async function suiteAccessToken(suite: WecomSuite): Promise<string> {
    const cached = tokens.get(suite.suiteId);
    if (cached && cached.expiresAt > nowMs()) return cached.token;
    const ticket = await deps.loadSuiteTicket(suite.suiteId);
    if (!ticket) {
      // WeCom pushes the first ticket within ten minutes of the callback URL
      // being verified, then every ten minutes. Nothing to do but wait.
      throw new ApiError(503, "unavailable", "WeCom has not pushed a suite_ticket yet; check the callback URL in the provider console");
    }
    const body = await call(
      fetchImpl,
      `${API}/service/get_suite_token`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ suite_id: suite.suiteId, suite_secret: suite.suiteSecret, suite_ticket: ticket }),
      },
      "get_suite_token",
    );
    const token = String(body.suite_access_token ?? "");
    if (!token) throw new ApiError(502, "upstream_error", "WeCom get_suite_token returned no token");
    const ttl = Math.max(60, Number(body.expires_in ?? 7200) - 300) * 1000;
    tokens.set(suite.suiteId, { token, expiresAt: nowMs() + ttl });
    return token;
  }

  // provider_access_token per provider corp, and gettoken per (corp, secret).
  const providerTokens = new Map<string, { token: string; expiresAt: number }>();
  const corpTokens = new Map<string, { token: string; expiresAt: number }>();
  const openCorpIds = new Map<string, string>();

  async function providerAccessToken(providerCorpId: string, providerSecret: string): Promise<string> {
    const cached = providerTokens.get(providerCorpId);
    if (cached && cached.expiresAt > nowMs()) return cached.token;
    const body = await call(
      fetchImpl,
      `${API}/service/get_provider_token`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ corpid: providerCorpId, provider_secret: providerSecret }),
      },
      "get_provider_token",
    );
    const token = String(body.provider_access_token ?? "");
    if (!token) throw new ApiError(502, "upstream_error", "WeCom get_provider_token returned no token");
    const ttl = Math.max(60, Number(body.expires_in ?? 7200) - 300) * 1000;
    providerTokens.set(providerCorpId, { token, expiresAt: nowMs() + ttl });
    return token;
  }

  async function corpAccessToken(corpId: string, secret: string): Promise<string> {
    const key = `${corpId}\u0000${secret}`;
    const cached = corpTokens.get(key);
    if (cached && cached.expiresAt > nowMs()) return cached.token;
    const u = new URL(`${API}/gettoken`);
    u.searchParams.set("corpid", corpId);
    u.searchParams.set("corpsecret", secret);
    const body = await call(fetchImpl, u.toString(), undefined, "gettoken");
    const token = String(body.access_token ?? "");
    if (!token) throw new ApiError(502, "upstream_error", "WeCom gettoken returned no token");
    const ttl = Math.max(60, Number(body.expires_in ?? 7200) - 300) * 1000;
    corpTokens.set(key, { token, expiresAt: nowMs() + ttl });
    return token;
  }

  return {
    suiteAccessToken,

    /** The person behind a Web-login `code`. null when they are not a corp member. */
    async loginIdentity(suite: WecomSuite, code: string): Promise<WecomLoginIdentity | null> {
      const token = await suiteAccessToken(suite);
      const u = new URL(`${API}/service/auth/getuserinfo3rd`);
      u.searchParams.set("suite_access_token", token);
      u.searchParams.set("code", code);
      const body = await call(fetchImpl, u.toString(), undefined, "getuserinfo3rd");
      if (!body.corpid || !body.open_userid) return null; // `openid` only: not in any corp
      return {
        corpId: String(body.corpid),
        openUserId: String(body.open_userid),
        userId: body.userid ? String(body.userid) : null,
      };
    },

    async preAuthCode(suite: WecomSuite, opts: { testMode: boolean }): Promise<string> {
      const token = await suiteAccessToken(suite);
      const body = await call(
        fetchImpl,
        `${API}/service/get_pre_auth_code?suite_access_token=${encodeURIComponent(token)}`,
        undefined,
        "get_pre_auth_code",
      );
      const pre = String(body.pre_auth_code ?? "");
      if (!pre) throw new ApiError(502, "upstream_error", "WeCom get_pre_auth_code returned no code");
      if (opts.testMode) {
        // auth_type 1 = test install, required while the app is unpublished.
        await call(
          fetchImpl,
          `${API}/service/set_session_info?suite_access_token=${encodeURIComponent(token)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ pre_auth_code: pre, session_info: { auth_type: 1 } }),
          },
          "set_session_info",
        );
      }
      return pre;
    },

    async permanentAuth(suite: WecomSuite, authCode: string): Promise<WecomPermanentAuth> {
      const token = await suiteAccessToken(suite);
      const body = await call(
        fetchImpl,
        `${API}/service/get_permanent_code?suite_access_token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ auth_code: authCode }),
        },
        "get_permanent_code",
      );
      const corpId = String(body?.auth_corp_info?.corpid ?? "");
      if (!corpId || !body.permanent_code) {
        throw new ApiError(502, "upstream_error", "WeCom get_permanent_code returned no corp");
      }
      return {
        permanentCode: String(body.permanent_code),
        corpId,
        corpName: body.auth_corp_info?.corp_name ? String(body.auth_corp_info.corp_name) : null,
        installerOpenUserId: body.auth_user_info?.open_userid ? String(body.auth_user_info.open_userid) : null,
      };
    },

    /**
     * The QR link a company admin scans to authorize the 代开发 template.
     * `state` must be 1–32 letters / digits; WeCom echoes it in create_auth.
     */
    async directoryAuthUrl(args: {
      providerCorpId: string;
      providerSecret: string;
      templateId: string;
      state: string;
    }): Promise<{ qrcodeUrl: string; expiresInSec: number }> {
      const token = await providerAccessToken(args.providerCorpId, args.providerSecret);
      const body = await call(
        fetchImpl,
        `${API}/service/get_customized_auth_url?provider_access_token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ state: args.state, templateid_list: [args.templateId] }),
        },
        "get_customized_auth_url",
      );
      const qrcodeUrl = String(body.qrcode_url ?? "");
      if (!qrcodeUrl) throw new ApiError(502, "upstream_error", "WeCom get_customized_auth_url returned no link");
      return { qrcodeUrl, expiresInSec: Number(body.expires_in ?? 0) || 0 };
    },

    /**
     * A company's corpid as the provider's 代开发 apps see it
     * (service/corpid_to_opencorpid, document/path/95327). The sign-in app may
     * hold a plaintext `ww…` corpid while the 代开发 app gets the encrypted
     * `wp…` one; this is how the two are matched. Cached for the process: the
     * mapping is fixed per provider.
     */
    async openCorpId(args: { providerCorpId: string; providerSecret: string; corpId: string }): Promise<string> {
      const cached = openCorpIds.get(args.corpId);
      if (cached) return cached;
      const token = await providerAccessToken(args.providerCorpId, args.providerSecret);
      const body = await call(
        fetchImpl,
        `${API}/service/corpid_to_opencorpid?provider_access_token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ corpid: args.corpId }),
        },
        "corpid_to_opencorpid",
      );
      const open = String(body.open_corpid ?? "");
      if (!open) throw new ApiError(502, "upstream_error", "WeCom corpid_to_opencorpid returned no corpid");
      openCorpIds.set(args.corpId, open);
      return open;
    },

    /** Exchange a 代开发 create_auth / reset_permanent_code AuthCode for the company's secret. */
    async directoryPermanentAuth(template: WecomSuite, authCode: string): Promise<WecomDirectoryAuth> {
      const token = await suiteAccessToken(template);
      const body = await call(
        fetchImpl,
        `${API}/service/v2/get_permanent_code?suite_access_token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ auth_code: authCode }),
        },
        "v2/get_permanent_code",
      );
      const corpId = String(body?.auth_corp_info?.corpid ?? "");
      if (!corpId || !body.permanent_code) {
        throw new ApiError(502, "upstream_error", "WeCom v2/get_permanent_code returned no corp");
      }
      return {
        permanentCode: String(body.permanent_code),
        corpId,
        corpName: body.auth_corp_info?.corp_name ? String(body.auth_corp_info.corp_name) : null,
        state: body.state ? String(body.state) : null,
      };
    },

    /** The 代开发 app's granted permissions in a company (agent/get_permissions). */
    async directoryPermissions(corpId: string, secret: string): Promise<string[]> {
      const token = await corpAccessToken(corpId, secret);
      const body = await call(
        fetchImpl,
        `${API}/agent/get_permissions?access_token=${encodeURIComponent(token)}`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
        "agent/get_permissions",
      );
      return Array.isArray(body.app_permissions) ? body.app_permissions.map(String) : [];
    },

    /**
     * A member's directory name, or null when WeCom does not reveal it (no
     * 「姓名」 grant: `name` comes back as the userid).
     */
    async directoryName(corpId: string, secret: string, userId: string): Promise<string | null> {
      const token = await corpAccessToken(corpId, secret);
      const u = new URL(`${API}/user/get`);
      u.searchParams.set("access_token", token);
      u.searchParams.set("userid", userId);
      const body = await call(fetchImpl, u.toString(), undefined, "user/get");
      const name = typeof body.name === "string" ? body.name.trim() : "";
      return name && name !== userId ? name : null;
    },

    /** Forget a company's cached token, e.g. after its secret was rotated. */
    forgetCorpToken(corpId: string) {
      for (const key of corpTokens.keys()) if (key.startsWith(`${corpId}\u0000`)) corpTokens.delete(key);
    },
  };
}

export type WecomClient = ReturnType<typeof createWecomClient>;

export function wecomLoginUrl(args: { appId: string; redirectUri: string; state: string; lang?: string }): string {
  const u = new URL("https://login.work.weixin.qq.com/wwlogin/sso/login");
  u.searchParams.set("login_type", "ServiceApp");
  u.searchParams.set("appid", args.appId);
  u.searchParams.set("redirect_uri", args.redirectUri);
  u.searchParams.set("state", args.state);
  if (args.lang) u.searchParams.set("lang", args.lang);
  return u.toString();
}

export function wecomInstallUrl(args: { suiteId: string; preAuthCode: string; redirectUri: string; state: string }): string {
  const u = new URL("https://open.work.weixin.qq.com/3rdapp/install");
  u.searchParams.set("suite_id", args.suiteId);
  u.searchParams.set("pre_auth_code", args.preAuthCode);
  u.searchParams.set("redirect_uri", args.redirectUri);
  u.searchParams.set("state", args.state);
  return u.toString();
}
