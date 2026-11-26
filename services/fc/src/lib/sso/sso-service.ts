// Enterprise IM sign-in (WeCom first). docs/specs/2026-11-26-enterprise-im-sso.md
//
// Login (a desktop / mobile client, PKCE like the GoTrue OAuth path):
//   1. GET  /v1/auth/sso/wecom/authorize?redirect=&code_challenge=
//        → flow row, 302 to WeCom's QR page (login_type=ServiceApp)
//   2. GET  /v1/auth/sso/wecom/callback?code=&state=
//        → getuserinfo3rd → identity in the corp's bound org (minted on first
//          scan) → one-time code → 302 to the client's redirect
//   3. POST /v1/auth/sso/exchange { code, codeVerifier }
//        → PKCE check → session (same shape as /v1/auth/oauth/exchange)
//
// Binding (an org admin, once per company):
//   1. POST /v1/teams/:teamId/sso/wecom/install → { url } (WeCom install page)
//   2. A WeCom admin of the company installs TeamClu's third-party app there;
//      WeCom redirects to GET /v1/auth/sso/wecom/install-callback?auth_code=&state=
//        → get_permanent_code → amux.sso_org_bindings (corp → org)
//   Only a WeCom admin can install, which is what stops an employee binding
//   their company to an org of their own.
//
// Member names (optional, docs/specs/2026-11-26-wecom-customized-app-names.md):
//   WeCom gives the third-party app no names. A company that also authorizes
//   TeamClu's 代开发 template (QR from POST /v1/teams/:teamId/sso/wecom/directory)
//   and grants 「姓名」 lets FC read them with user/get; a placeholder name is
//   then replaced on sign-in, on the grant, and on demand. Never a chosen name.
//
// The client redirect is restricted to loopback http and the brand's custom
// schemes. With an arbitrary redirect, anyone could start a flow with their own
// PKCE challenge, send the authorize link to a victim, and receive the code for
// the victim's scan.
import crypto from "crypto";

import { ApiError } from "../http-utils.js";
import {
  openWecomCallback,
  verifyWecomSignature,
  xmlField,
  WecomCryptoError,
  type WecomCryptoConfig,
} from "./wecom-crypto.js";
import {
  WECOM_NAME_PERMISSION,
  wecomInstallUrl,
  wecomLoginUrl,
  type WecomClient,
  type WecomSuite,
} from "./wecom-client.js";

export const SSO_PROVIDERS = ["wecom"] as const;
export type SsoProvider = (typeof SSO_PROVIDERS)[number];

const FLOW_TTL_MS = 10 * 60 * 1000;
/** Once the person has scanned, the client has this long to exchange the code. */
const EXCHANGE_TTL_MS = 2 * 60 * 1000;

export interface SsoFlow {
  state: string;
  provider: string;
  kind: "login" | "install" | "directory";
  redirect: string | null;
  codeChallenge: string | null;
  orgId: string | null;
  requestedBy: string | null;
  userId: string | null;
  expiresAt: string;
  consumedAt: string | null;
}

export interface SsoBinding {
  provider: string;
  tenantId: string;
  orgId: string;
  tenantName: string | null;
  createdAt: string;
}

export interface SsoDirectoryApp {
  provider: string;
  tenantId: string;
  permanentCode: string;
  namesGranted: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export class SsoTenantNotBoundError extends Error {}

export interface SsoStore {
  saveSuiteTicket(provider: string, suiteId: string, ticket: string): Promise<void>;
  loadSuiteTicket(provider: string, suiteId: string): Promise<string | null>;
  createFlow(flow: Omit<SsoFlow, "userId" | "consumedAt">): Promise<void>;
  getFlow(state: string): Promise<SsoFlow | null>;
  /** Record who signed in on a pending login flow. False if it was already used or expired. */
  completeLoginFlow(state: string, args: { userId: string; codeHash: string; expiresAt: string }): Promise<boolean>;
  /** Atomically mark the login flow holding this code consumed and return it. */
  consumeLoginCode(codeHash: string): Promise<SsoFlow | null>;
  /** Atomically mark an install flow consumed and return it. */
  consumeInstallFlow(state: string): Promise<SsoFlow | null>;
  /** Atomically mark a directory (代开发 authorization) flow consumed and return it. */
  consumeDirectoryFlow(state: string): Promise<SsoFlow | null>;
  sweepExpiredFlows(): Promise<void>;
  /** Throws SsoTenantNotBoundError when the company is not bound. */
  ensureIdentity(args: { provider: string; tenantId: string; subject: string; nickname?: string | null }): Promise<string>;
  mintSession(userId: string): Promise<string>;
  bindingForOrg(provider: string, orgId: string): Promise<SsoBinding | null>;
  bindingForTenant(provider: string, tenantId: string): Promise<SsoBinding | null>;
  saveBinding(args: {
    provider: string;
    tenantId: string;
    orgId: string;
    tenantName: string | null;
    permanentCode: string | null;
    boundBy: string | null;
  }): Promise<void>;
  deleteBinding(provider: string, tenantId: string): Promise<void>;
  getDirectoryApp(provider: string, tenantId: string): Promise<SsoDirectoryApp | null>;
  /** Insert or replace a company's 代开发 authorization (names unchecked again). */
  saveDirectoryApp(args: { provider: string; tenantId: string; permanentCode: string; authorizedBy: string | null }): Promise<void>;
  /** Replace the secret of an existing authorization. False if there is none. */
  rotateDirectoryAppSecret(provider: string, tenantId: string, permanentCode: string): Promise<boolean>;
  recordDirectoryCheck(provider: string, tenantId: string, result: { namesGranted: boolean; lastError: string | null }): Promise<void>;
  deleteDirectoryApp(provider: string, tenantId: string): Promise<void>;
  /** Identities of the company still on the placeholder name. */
  identitiesNeedingName(provider: string, tenantId: string): Promise<{ subject: string; userId: string }[]>;
  /** Replace the account's placeholder name; false when nothing was a placeholder. */
  applyDirectoryName(userId: string, name: string): Promise<boolean>;
  /** The caller and the team's org, if the caller is an owner/admin of that org. 403 otherwise. */
  resolveOrgManager(accessToken: string, teamId: string): Promise<{ userId: string; orgId: string }>;
}

export interface WecomSsoConfig {
  /** TeamClu's third-party app; companies install it to bind. */
  suite: WecomSuite;
  /** The provider's 登录授权 suite used as the QR login appid. Defaults to `suite`. */
  loginSuite?: WecomSuite;
  callback: WecomCryptoConfig;
  /**
   * The 登录授权 page's own Token + EncodingAESKey, when it does not reuse the
   * app's. The suite callback accepts a message signed with either pair.
   */
  loginCallback?: WecomCryptoConfig;
  /** Provider CorpID, accepted as a callback receiveId besides the suite ids. */
  providerCorpId?: string;
  /** Public origin WeCom redirects back to; must match the trusted domain. */
  redirectBaseUrl?: string;
  /** Install as a test authorization (auth_type 1) while the app is unpublished. */
  installTestMode?: boolean;
  /**
   * The 代开发 template used to read member names, and the provider secret
   * that get_customized_auth_url needs (with providerCorpId). Optional.
   */
  directory?: { template: WecomSuite; providerSecret: string };
}

export interface SsoServiceDeps {
  store: SsoStore;
  wecom?: { config: WecomSsoConfig; client: WecomClient };
  /** Turn a refresh token into a GoTrue session (FC's /v1/auth/refresh path). */
  refreshSession: (refreshToken: string) => Promise<any>;
  /** Extra custom schemes clients may use as the login redirect. */
  allowedRedirectSchemes?: string[];
  nowMs?: () => number;
  randomToken?: () => string;
  /**
   * Run work that must not hold up the response: WeCom wants callback answers
   * within a second, and sign-in must not wait on a name lookup. Defaults to
   * fire-and-forget with the error logged; tests collect and await it.
   */
  background?: (label: string, task: () => Promise<unknown>) => void;
}

/** WeCom's limit for get_customized_auth_url's state: 1–32 letters / digits. */
function directoryState(): string {
  return crypto.randomBytes(16).toString("hex");
}

const DIRECTORY_FLOW_MAX_MS = 10 * 24 * 60 * 60 * 1000;

/**
 * Open a callback with the app's key pair, falling back to the 登录授权 pair.
 * Only a signature mismatch moves on to the next pair; a message whose
 * signature verifies but fails to decrypt is rejected outright.
 */
function openWithAnyKey(
  config: WecomSsoConfig,
  args: { signature: string; timestamp: string; nonce: string; encrypt: string },
  receiveIds: string[] | "any",
): string {
  const keys = config.loginCallback ? [config.callback, config.loginCallback] : [config.callback];
  for (const key of keys) {
    if (verifyWecomSignature(key, args)) return openWecomCallback(key, args, receiveIds);
  }
  throw new WecomCryptoError("signature mismatch");
}

function defaultRandomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function sha256Base64Url(input: string): string {
  return crypto.createHash("sha256").update(input).digest("base64url");
}

function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

/**
 * Loopback http (any port) or a brand custom scheme (`teamclu://…`,
 * `teamclu-<brand>://…`, plus any configured extra). Nothing reachable from
 * another machine — see the header.
 */
export function isAllowedClientRedirect(raw: string, extraSchemes: string[] = []): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === "http:") return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  return /^teamclu(?:-[a-z0-9]+)*$/.test(scheme) || extraSchemes.map((s) => s.toLowerCase()).includes(scheme);
}

function withQuery(base: string, params: Record<string, string>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** A minimal standalone page for the browser tab WeCom redirected. */
export function ssoResultPage(title: string, detail: string, ok: boolean): string {
  const accent = ok ? "#2f7d4f" : "#b4432f";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f4ef;color:#2b2a27;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:420px;padding:32px 24px;text-align:center}h1{font-size:20px;color:${accent};margin:0 0 12px}p{line-height:1.6;margin:0;color:#5c5a55}
@media(prefers-color-scheme:dark){body{background:#1d1c1a;color:#ece9e2}p{color:#b3afa6}}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body></html>`;
}

export function createSsoService(deps: SsoServiceDeps) {
  const { store, refreshSession } = deps;
  const nowMs = deps.nowMs ?? (() => Date.now());
  const randomToken = deps.randomToken ?? defaultRandomToken;
  const extraSchemes = deps.allowedRedirectSchemes ?? [];
  const background =
    deps.background ??
    ((label: string, task: () => Promise<unknown>) => {
      void task().catch((e) => console.error(`sso: ${label} failed:`, e?.message ?? e));
    });

  function wecom() {
    if (!deps.wecom) {
      throw new ApiError(501, "not_implemented", "WeCom sign-in is not configured on this deployment");
    }
    return deps.wecom;
  }

  function assertProvider(provider: string): asserts provider is SsoProvider {
    if (!(SSO_PROVIDERS as readonly string[]).includes(provider)) {
      throw new ApiError(404, "not_found", `unknown sign-in provider: ${provider}`);
    }
  }

  function baseUrl(requestOrigin: string | null): string {
    const base = wecom().config.redirectBaseUrl || requestOrigin;
    if (!base) throw new ApiError(500, "internal", "cannot determine the public URL for the WeCom redirect");
    return base.replace(/\/+$/, "");
  }

  function iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  function live(flow: SsoFlow | null, kind: SsoFlow["kind"]): flow is SsoFlow {
    return !!flow && flow.kind === kind && !flow.consumedAt && Date.parse(flow.expiresAt) > nowMs();
  }

  function directory() {
    const w = wecom();
    const d = w.config.directory;
    if (!d || !w.config.providerCorpId) {
      throw new ApiError(501, "not_implemented", "WeCom member names are not configured on this deployment");
    }
    return { ...w, directory: d, providerCorpId: w.config.providerCorpId };
  }

  /**
   * Ask WeCom whether the company's 代开发 app can read names now, record the
   * answer, and return it. Errors (app still 开发中, secret revoked, no
   * licence) count as "not granted" and are kept as lastError.
   */
  async function checkDirectory(provider: string, tenantId: string): Promise<SsoDirectoryApp | null> {
    const { client } = wecom();
    const app = await store.getDirectoryApp(provider, tenantId);
    if (!app) return null;
    let namesGranted = false;
    let lastError: string | null = null;
    try {
      const permissions = await client.directoryPermissions(tenantId, app.permanentCode);
      namesGranted = permissions.includes(WECOM_NAME_PERMISSION);
      if (!namesGranted) lastError = "「姓名」权限未授予";
    } catch (e: any) {
      lastError = String(e?.message ?? e).slice(0, 500);
    }
    await store.recordDirectoryCheck(provider, tenantId, { namesGranted, lastError });
    return { ...app, namesGranted, lastError, lastCheckedAt: iso(nowMs()) };
  }

  /**
   * Fill placeholder names of the company's identities from the directory
   * (all of them, or only `onlySubject`). Returns how many accounts changed.
   */
  async function fillNames(provider: string, tenantId: string, onlySubject?: string): Promise<number> {
    const { client } = wecom();
    const app = await store.getDirectoryApp(provider, tenantId);
    if (!app?.namesGranted) return 0;
    let pending = await store.identitiesNeedingName(provider, tenantId);
    if (onlySubject !== undefined) pending = pending.filter((p) => p.subject === onlySubject);
    let updated = 0;
    for (const { subject, userId } of pending) {
      // The third-party app's open_userid equals the 代开发 app's userid for
      // companies authorized after the 2022 ID upgrade (document/path/97104).
      let name: string | null;
      try {
        name = await client.directoryName(tenantId, app.permanentCode, subject);
      } catch (e: any) {
        console.error(`sso: user/get for a ${tenantId} member failed:`, e?.message ?? e);
        continue;
      }
      if (name && (await store.applyDirectoryName(userId, name.slice(0, 64)))) updated++;
    }
    return updated;
  }

  /** A 代开发 template callback (create_auth / change_auth / reset_permanent_code / cancel_auth). */
  async function handleDirectoryEvent(provider: string, xml: string): Promise<void> {
    const { client, directory: d } = directory();
    const infoType = xmlField(xml, "InfoType");
    const corpIdFromXml = xmlField(xml, "AuthCorpId");
    if (infoType === "create_auth") {
      const authCode = xmlField(xml, "AuthCode");
      if (!authCode) return;
      const auth = await client.directoryPermanentAuth(d.template, authCode);
      const state = xmlField(xml, "State") || auth.state;
      const flow = state ? await store.consumeDirectoryFlow(state) : null;
      if (!flow || !flow.orgId || Date.parse(flow.expiresAt) <= nowMs()) {
        console.error(`sso: 代开发 authorization from ${auth.corpId} has no live TeamClu link; ignored`);
        return;
      }
      const binding = await store.bindingForTenant(provider, auth.corpId);
      if (!binding || binding.orgId !== flow.orgId) {
        console.error(`sso: 代开发 authorization from ${auth.corpId} is not the company bound to the requesting org; ignored`);
        return;
      }
      await store.saveDirectoryApp({ provider, tenantId: auth.corpId, permanentCode: auth.permanentCode, authorizedBy: flow.requestedBy });
      const app = await checkDirectory(provider, auth.corpId);
      if (app?.namesGranted) await fillNames(provider, auth.corpId);
    } else if (infoType === "reset_permanent_code") {
      const authCode = xmlField(xml, "AuthCode");
      if (!authCode) return;
      const auth = await client.directoryPermanentAuth(d.template, authCode);
      client.forgetCorpToken(auth.corpId);
      if (await store.rotateDirectoryAppSecret(provider, auth.corpId, auth.permanentCode)) {
        await checkDirectory(provider, auth.corpId);
      }
    } else if (infoType === "change_auth" && corpIdFromXml) {
      const app = await checkDirectory(provider, corpIdFromXml);
      if (app?.namesGranted) await fillNames(provider, corpIdFromXml);
    } else if (infoType === "cancel_auth" && corpIdFromXml) {
      // Only the names app goes; the company still signs in.
      await store.deleteDirectoryApp(provider, corpIdFromXml);
      client.forgetCorpToken(corpIdFromXml);
    }
  }

  function directoryView(app: SsoDirectoryApp | null) {
    return app
      ? { namesGranted: app.namesGranted, lastCheckedAt: app.lastCheckedAt, lastError: app.lastError, createdAt: app.createdAt }
      : null;
  }

  return {
    async loginAuthorizeUrl(args: {
      provider: string;
      redirect: string;
      codeChallenge: string;
      requestOrigin: string | null;
      lang?: string;
    }): Promise<string> {
      assertProvider(args.provider);
      const { config } = wecom();
      if (!isAllowedClientRedirect(args.redirect, extraSchemes)) {
        throw new ApiError(400, "validation_failed", "redirect must be a loopback or app URL");
      }
      if (!/^[A-Za-z0-9_-]{43}$/.test(args.codeChallenge)) {
        throw new ApiError(400, "validation_failed", "code_challenge must be an S256 challenge");
      }
      await store.sweepExpiredFlows().catch((e) => console.error("sso: sweep failed:", e?.message ?? e));
      const state = randomToken();
      await store.createFlow({
        state,
        provider: args.provider,
        kind: "login",
        redirect: args.redirect,
        codeChallenge: args.codeChallenge,
        orgId: null,
        requestedBy: null,
        expiresAt: iso(nowMs() + FLOW_TTL_MS),
      });
      const loginSuite = config.loginSuite ?? config.suite;
      return wecomLoginUrl({
        appId: loginSuite.suiteId,
        redirectUri: `${baseUrl(args.requestOrigin)}/v1/auth/sso/wecom/callback`,
        state,
        lang: args.lang,
      });
    },

    /**
     * WeCom's redirect after a scan. Returns where to send the browser: the
     * client's redirect with `code` or `error`, or — when the flow itself is
     * unknown, so there is no client redirect to trust — a result page.
     */
    async handleLoginCallback(args: {
      provider: string;
      code: string | null;
      state: string | null;
    }): Promise<{ redirect: string } | { html: string; status: number }> {
      assertProvider(args.provider);
      const { config, client } = wecom();
      const flow = args.state ? await store.getFlow(args.state) : null;
      if (!live(flow, "login") || flow.userId || !flow.redirect) {
        return {
          status: 400,
          html: ssoResultPage("登录已失效", "这个登录链接已过期或已使用，请回到 TeamClu 重新发起企业微信登录。", false),
        };
      }
      const fail = (error: string, description: string) => ({
        redirect: withQuery(flow.redirect!, { error, error_description: description }),
      });
      if (!args.code) return fail("access_denied", "企业微信登录已取消");

      const who = await client.loginIdentity(config.loginSuite ?? config.suite, args.code).catch((e) => {
        console.error("sso: getuserinfo3rd failed:", e?.message ?? e);
        return undefined;
      });
      if (who === undefined) return fail("server_error", "企业微信暂时无法确认你的身份，请稍后再试");
      if (who === null) return fail("access_denied", "只有企业成员可以用企业微信登录");

      let userId: string;
      try {
        userId = await store.ensureIdentity({ provider: args.provider, tenantId: who.corpId, subject: who.openUserId });
      } catch (e) {
        if (e instanceof SsoTenantNotBoundError) {
          return fail("org_not_connected", "你的企业还没有连接 TeamClu。请企业的 TeamClu 管理员先在设置里连接企业微信。");
        }
        throw e;
      }

      if (config.directory) {
        background("directory name on sign-in", () => fillNames(args.provider, who.corpId, who.openUserId));
      }

      const code = randomToken();
      const ok = await store.completeLoginFlow(flow.state, {
        userId,
        codeHash: hashCode(code),
        expiresAt: iso(nowMs() + EXCHANGE_TTL_MS),
      });
      if (!ok) return fail("invalid_request", "这个登录链接已使用，请重新发起登录");
      return { redirect: withQuery(flow.redirect, { code, state: flow.state }) };
    },

    async exchange(args: { code: string; codeVerifier: string }) {
      // Consumed before the PKCE check on purpose: a wrong verifier burns the
      // code, so it cannot be guessed at.
      const flow = await store.consumeLoginCode(hashCode(args.code));
      if (!flow || !flow.userId || Date.parse(flow.expiresAt) <= nowMs()) {
        throw new ApiError(400, "validation_failed", "invalid or expired sign-in code");
      }
      if (!flow.codeChallenge || sha256Base64Url(args.codeVerifier) !== flow.codeChallenge) {
        throw new ApiError(400, "validation_failed", "code verifier does not match");
      }
      const refreshToken = await store.mintSession(flow.userId);
      return refreshSession(refreshToken);
    },

    async binding(args: { provider: string; accessToken: string; teamId: string }) {
      assertProvider(args.provider);
      const { orgId } = await store.resolveOrgManager(args.accessToken, args.teamId);
      const b = await store.bindingForOrg(args.provider, orgId);
      const directoryConfigured = !!deps.wecom?.config.directory && !!deps.wecom?.config.providerCorpId;
      return {
        configured: !!deps.wecom,
        binding: b ? { tenantId: b.tenantId, tenantName: b.tenantName, createdAt: b.createdAt } : null,
        directoryConfigured,
        directory: b && directoryConfigured ? directoryView(await store.getDirectoryApp(args.provider, b.tenantId)) : null,
      };
    },

    async installUrl(args: { provider: string; accessToken: string; teamId: string; requestOrigin: string | null }) {
      assertProvider(args.provider);
      const { config, client } = wecom();
      const { userId, orgId } = await store.resolveOrgManager(args.accessToken, args.teamId);
      const existing = await store.bindingForOrg(args.provider, orgId);
      if (existing) {
        throw new ApiError(409, "conflict", "this organization is already connected to a WeCom company; disconnect it first");
      }
      const preAuthCode = await client.preAuthCode(config.suite, { testMode: !!config.installTestMode });
      const state = randomToken();
      await store.createFlow({
        state,
        provider: args.provider,
        kind: "install",
        redirect: null,
        codeChallenge: null,
        orgId,
        requestedBy: userId,
        expiresAt: iso(nowMs() + FLOW_TTL_MS),
      });
      return {
        url: wecomInstallUrl({
          suiteId: config.suite.suiteId,
          preAuthCode,
          redirectUri: `${baseUrl(args.requestOrigin)}/v1/auth/sso/wecom/install-callback`,
          state,
        }),
      };
    },

    /** WeCom's redirect after a company admin installed the app. Returns a result page. */
    async handleInstallCallback(args: {
      provider: string;
      authCode: string | null;
      state: string | null;
    }): Promise<{ html: string; status: number }> {
      assertProvider(args.provider);
      const { config, client } = wecom();
      const flow = args.state ? await store.consumeInstallFlow(args.state) : null;
      if (!flow || !flow.orgId || Date.parse(flow.expiresAt) <= nowMs()) {
        return { status: 400, html: ssoResultPage("连接已失效", "这个连接链接已过期或已使用，请回到 TeamClu 设置重新连接企业微信。", false) };
      }
      if (!args.authCode) {
        return { status: 400, html: ssoResultPage("未完成授权", "企业微信没有返回授权结果，请重试。", false) };
      }
      const auth = await client.permanentAuth(config.suite, args.authCode);
      const holder = await store.bindingForTenant(args.provider, auth.corpId);
      if (holder && holder.orgId !== flow.orgId) {
        return {
          status: 409,
          html: ssoResultPage(
            "该企业已连接其他组织",
            `${auth.corpName ?? "这个企业"} 已经连接了另一个 TeamClu 组织。请先在那个组织里断开连接。`,
            false,
          ),
        };
      }
      await store.saveBinding({
        provider: args.provider,
        tenantId: auth.corpId,
        orgId: flow.orgId,
        tenantName: auth.corpName,
        permanentCode: auth.permanentCode,
        boundBy: flow.requestedBy,
      });
      return {
        status: 200,
        html: ssoResultPage(
          "已连接企业微信",
          `${auth.corpName ?? "你的企业"} 的成员现在可以用企业微信扫码登录 TeamClu。可以关闭这个页面了。`,
          true,
        ),
      };
    },

    async unbind(args: { provider: string; accessToken: string; teamId: string }) {
      assertProvider(args.provider);
      const { orgId } = await store.resolveOrgManager(args.accessToken, args.teamId);
      const b = await store.bindingForOrg(args.provider, orgId);
      if (b) await store.deleteBinding(args.provider, b.tenantId);
      return { removed: !!b };
    },

    /**
     * The QR link a WeCom admin of the bound company scans to authorize the
     * 代开发 template, so that member names can be read. Org owner/admin only.
     */
    async directoryAuthUrl(args: { provider: string; accessToken: string; teamId: string }) {
      assertProvider(args.provider);
      const { client, directory: d, providerCorpId } = directory();
      const { userId, orgId } = await store.resolveOrgManager(args.accessToken, args.teamId);
      const binding = await store.bindingForOrg(args.provider, orgId);
      if (!binding) {
        throw new ApiError(409, "conflict", "connect the organization to its WeCom company first");
      }
      const state = directoryState();
      const { qrcodeUrl, expiresInSec } = await client.directoryAuthUrl({
        providerCorpId,
        providerSecret: d.providerSecret,
        templateId: d.template.suiteId,
        state,
      });
      const ttl = Math.min(expiresInSec > 0 ? expiresInSec * 1000 : DIRECTORY_FLOW_MAX_MS, DIRECTORY_FLOW_MAX_MS);
      const expiresAt = iso(nowMs() + ttl);
      await store.createFlow({
        state,
        provider: args.provider,
        kind: "directory",
        redirect: null,
        codeChallenge: null,
        orgId,
        requestedBy: userId,
        expiresAt,
      });
      return { qrcodeUrl, expiresAt };
    },

    /**
     * Re-check the company's 代开发 grant and fill every placeholder name it
     * can. Org owner/admin only.
     */
    async syncDirectory(args: { provider: string; accessToken: string; teamId: string }) {
      assertProvider(args.provider);
      directory();
      const { orgId } = await store.resolveOrgManager(args.accessToken, args.teamId);
      const binding = await store.bindingForOrg(args.provider, orgId);
      if (!binding) throw new ApiError(409, "conflict", "connect the organization to its WeCom company first");
      const app = await checkDirectory(args.provider, binding.tenantId);
      if (!app) throw new ApiError(409, "conflict", "the WeCom company has not authorized member names yet");
      const updated = app.namesGranted ? await fillNames(args.provider, binding.tenantId) : 0;
      return { directory: directoryView(app), updated };
    },

    /**
     * The provider callback URL (指令回调). GET is WeCom's URL verification
     * (answer the decrypted echostr); POST carries suite_ticket and
     * install / uninstall notices (answer "success").
     */
    async handleSuiteCallback(args: {
      method: "GET" | "POST";
      query: URLSearchParams;
      body: string;
    }): Promise<{ text: string; status: number }> {
      const { config } = wecom();
      // Any receiveId: the 登录授权 suite signs with its own SuiteID, which is
      // only known after the console saves this URL. The signature over our
      // Token is what authenticates the caller, so a ticket is stored for any
      // SuiteId that arrives signed.
      const receiveIds = "any" as const;
      const signature = args.query.get("msg_signature") ?? "";
      const timestamp = args.query.get("timestamp") ?? "";
      const nonce = args.query.get("nonce") ?? "";
      try {
        if (args.method === "GET") {
          const echostr = args.query.get("echostr") ?? "";
          const plain = openWithAnyKey(config, { signature, timestamp, nonce, encrypt: echostr }, receiveIds);
          return { status: 200, text: plain };
        }
        const encrypt = xmlField(args.body, "Encrypt");
        if (!encrypt) return { status: 400, text: "missing Encrypt" };
        const xml = openWithAnyKey(config, { signature, timestamp, nonce, encrypt }, receiveIds);
        const infoType = xmlField(xml, "InfoType");
        const fromDirectoryTemplate =
          !!config.directory && xmlField(xml, "SuiteId") === config.directory.template.suiteId;
        if (fromDirectoryTemplate && infoType !== "suite_ticket") {
          // Answered at once; the WeCom calls behind it run afterwards.
          background(`代开发 ${infoType}`, () => handleDirectoryEvent("wecom", xml));
          return { status: 200, text: "success" };
        }
        if (infoType === "suite_ticket") {
          const suiteId = xmlField(xml, "SuiteId");
          const ticket = xmlField(xml, "SuiteTicket");
          if (suiteId && ticket) {
            await store.saveSuiteTicket("wecom", suiteId, ticket);
          }
        } else if (infoType === "cancel_auth") {
          // The company uninstalled the app: it no longer signs in anywhere.
          const corpId = xmlField(xml, "AuthCorpId");
          if (corpId) await store.deleteBinding("wecom", corpId);
        }
        // create_auth (installed from the WeCom app market, not our install
        // link) carries no org, so there is nothing to bind; change_auth and
        // contact events need no action for sign-in.
        return { status: 200, text: "success" };
      } catch (e) {
        if (e instanceof WecomCryptoError) {
          console.error("sso: rejected WeCom callback:", e.message);
          return { status: 403, text: "forbidden" };
        }
        throw e;
      }
    },

    /**
     * The data callback URL (数据回调): contact and user events from each
     * customer company. Sign-in uses none of them; this only answers WeCom's URL
     * verification and acknowledges events so the console stops reporting the
     * URL as unresponsive. Signature-checked; any receiveId (customer corpid).
     */
    async handleDataCallback(args: {
      method: "GET" | "POST";
      query: URLSearchParams;
      body: string;
    }): Promise<{ text: string; status: number }> {
      const { config } = wecom();
      const signature = args.query.get("msg_signature") ?? "";
      const timestamp = args.query.get("timestamp") ?? "";
      const nonce = args.query.get("nonce") ?? "";
      try {
        if (args.method === "GET") {
          const echostr = args.query.get("echostr") ?? "";
          return { status: 200, text: openWecomCallback(config.callback, { signature, timestamp, nonce, encrypt: echostr }, "any") };
        }
        const encrypt = xmlField(args.body, "Encrypt");
        if (!encrypt) return { status: 400, text: "missing Encrypt" };
        openWecomCallback(config.callback, { signature, timestamp, nonce, encrypt }, "any");
        return { status: 200, text: "success" };
      } catch (e) {
        if (e instanceof WecomCryptoError) {
          console.error("sso: rejected WeCom data callback:", e.message);
          return { status: 403, text: "forbidden" };
        }
        throw e;
      }
    },
  };
}

export type SsoService = ReturnType<typeof createSsoService>;
