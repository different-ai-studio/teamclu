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
