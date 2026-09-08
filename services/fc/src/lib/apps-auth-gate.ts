import {
  APP_AUTH_CALLBACK_PATH,
  APP_AUTH_LOGOUT_PATH,
  APP_COOKIE,
  APP_TTL_SECONDS,
  clearSessionCookie,
  consumeAuthCode,
  mintAppSession,
  readCookie,
  serializeSessionCookie,
  shouldRenew,
  verifyAppSession,
} from "./apps-auth-session.js";
import { esc, page, redirect, safeNext } from "./apps-auth-page.js";
import { appOrigins } from "./apps-public-host.js";
import { pathRequiresLogin } from "./apps-auth-paths.js";
import type { ProxyIdentity } from "./apps-vanity.js";

/**
 * The login wall, on the app's own hostname
 * (`docs/specs/2026-09-08-apps-login-and-custom-domain-design.md` §4.2, §4.7).
 *
 * It sits in the proxy, not in the app, and that placement is the entire point:
 * an app's code is generated and rewritten by an agent, so a wall living inside
 * it survives exactly until the next rewrite — while the control panel goes on
 * claiming the app requires a login. Two of the three templates are static file
 * servers that could not host a wall at all.
 *
 * What it does NOT do is run the login. That happens on the central login
 * hostname; this side only verifies a cookie, redeems the one-shot code that
 * hostname issues, and decides whether the visitor is allowed in.
 */

export type GateApp = {
  id: string;
  slug: string;
  /** `apps.team_id` — the org audience resolves the app's org through it. */
  teamId: string | null;
  /** `apps.auth_mode`; only `platform` has a wall. */
  authMode: string | null;
  /** `apps.auth_audience`: `any` | `org`. Unset is read as `org` (fail closed). */
  authAudience: string | null;
  /** `apps.auth_scope`: `all` | `paths`. Anything else behaves as `all`. */
  authScope: string | null;
  /** `apps.auth_rules` — raw, validated on write and read leniently here. */
  authRules: unknown;
};

export type OrgPair = {
  /** `public.users.org_id` for the signed-in visitor; null when they have none. */
  visitorOrgId: string | null;
  /** `teams.oid` for the app's team; null when the team has no org. */
  appOrgId: string | null;
};

export type GateDeps = {
  /**
   * The two org ids the `org` audience compares.
   *
   * Injected because answering it needs two control-plane reads that this
   * module has no business owning. It returns both ids rather than a verdict so
   * the gateway can tell "this visitor is in the wrong org" (their problem)
   * from "this app's team has no org at all" (an operator's problem) — and so
   * the visitor's org can be forwarded to the app.
   */
  resolveOrgs: (userId: string, teamId: string | null) => Promise<OrgPair>;
  env?: NodeJS.ProcessEnv;
  /** False only on a plain-http local box. */
  secureCookies?: boolean;
};

/**
 * Flat, not a discriminated union: this package compiles with `strict: false`,
 * where TypeScript will not narrow a union by its discriminant. See the same
 * note in `apps-login-service.ts`.
 */
export type GateOutcome = {
  /** Non-null: the gateway answered. Return it unchanged, do not proxy. */
  response: Response | null;
  /** Non-null: proxy the request and attach this identity. */
  identity: ProxyIdentity | null;
  /** Non-null: append this `Set-Cookie` to the proxied response. */
  setCookie: string | null;
};

const PROCEED_ANONYMOUS: GateOutcome = { response: null, identity: null, setCookie: null };

const answered = (response: Response): GateOutcome => ({
  response,
  identity: null,
  setCookie: null,
});

/** Paths the gateway owns. Never forwarded, whatever the app's auth mode. */
function isGatewayPath(path: string): boolean {
  return path === APP_AUTH_CALLBACK_PATH || path === APP_AUTH_LOGOUT_PATH;
}

function loginDomain(env: NodeJS.ProcessEnv): string {
  return env.LOGIN_DOMAIN?.trim() ?? "";
}

/**
 * A deployment that cannot run the login flow refuses to serve the app.
 *
 * The tempting alternative — serve it anyway — is exactly the failure this
 * whole feature exists to remove: an app marked as requiring a login, served
 * to the public, with the control panel reporting that it is protected. Fail
 * closed and say why.
 */
function misconfigured(reason: string): Response {
  return page(
    "无法访问",
    `<h1>登录未配置</h1><p class="sub">这个应用需要登录，但当前部署无法提供登录服务` +
      `（${esc(reason)}）。请联系管理员。</p>`,
    503,
  );
}

function loginUrl(app: GateApp, origin: string, next: string, env: NodeJS.ProcessEnv): string {
  const params = new URLSearchParams({ app: app.id, r: origin, next });
  return `https://${loginDomain(env)}/?${params.toString()}`;
}

/**
 * The origin this app is being visited on.
 *
 * Chosen FROM the app's registered origins by matching the request's host,
 * never built from the host directly: the value is handed to the login service
 * as `r`, and that service checks it against this same list. Deriving it from
 * the request would drift the moment a scheme or a port differed, and every
 * login would fail the redirect check with a 400.
 *
 * Matching the host matters once a custom domain exists — a visitor who
 * arrived on it must be sent back to it, not to the vanity name, or their
 * session cookie would land on a hostname they are not using.
 */
function currentOrigin(app: GateApp, env: NodeJS.ProcessEnv, host: string): string | null {
  const origins = appOrigins(app, env);
  if (origins.length === 0) return null;
  const name = host.split(":")[0].trim().toLowerCase();
  const match = origins.find((o) => {
    try {
      return new URL(o).hostname === name;
    } catch {
      return false;
    }
  });
  return match ?? origins[0];
}

/**
 * Redeem the one-shot code the login service issued, and turn it into a cookie
 * on this hostname.
 *
 * A visitor who already holds a valid session is let through without touching
 * the code at all — refreshing the callback URL is the ordinary way to arrive
 * here with a spent code, and re-running the login for it would be a loop.
 */
async function handleCallback(
  url: URL,
  req: Request,
  app: GateApp,
  origin: string,
  env: NodeJS.ProcessEnv,
  secure: boolean,
): Promise<Response> {
  const next = safeNext(url.searchParams.get("next"));

  const existing = await verifyAppSession(
    readCookie(req.headers.get("cookie"), APP_COOKIE) ?? "",
    app.id,
  );
  if (existing) return redirect(`${origin}${next}`);

  const claims = await consumeAuthCode(url.searchParams.get("code") ?? "", {
    appId: app.id,
    redirect: origin,
  });
  if (!claims) {
    // Deliberately a page with a link, not an automatic bounce back to the
    // login service. An expired or replayed code that redirected itself could
    // loop forever if the two sides ever disagreed about the signing key; one
    // click costs the visitor nothing and cannot loop.
    return page(
      "登录已失效",
      `<h1>登录已失效</h1><p class="sub">这个登录链接已过期或已被使用。</p>` +
        `<a class="btn" href="${esc(loginUrl(app, origin, next, env))}">重新登录</a>`,
      400,
    );
  }

  const session = await mintAppSession({
    sub: claims.sub,
    email: claims.email,
    appId: app.id,
  });
  return redirect(`${origin}${next}`, [
    serializeSessionCookie(APP_COOKIE, session.token, APP_TTL_SECONDS, secure),
  ]);
}

/**
 * Clear this app's session, then hand the visitor to the central logout.
 *
 * Both halves are required. Dropping only this cookie would leave the SSO
 * cookie alive, and the next request to this app would be signed straight back
 * in — a logout button that visibly does nothing.
 */
function handleLogout(app: GateApp, origin: string, env: NodeJS.ProcessEnv, secure: boolean): Response {
  const domain = loginDomain(env);
  const target = domain ? `https://${domain}/logout` : `${origin}/`;
  return redirect(target, [clearSessionCookie(APP_COOKIE, secure)]);
}

function wrongOrgPage(app: GateApp, origin: string, email: string): Response {
  return page(
    "无权访问",
    `<h1>无权访问</h1>` +
      `<p class="sub">当前账号 ${esc(email)} 不属于这个应用所在的组织。</p>` +
      `<form method="post" action="${esc(APP_AUTH_LOGOUT_PATH)}">` +
      `<button type="submit">换一个账号</button></form>`,
    403,
  );
}

/**
 * Decide what happens to one request for a deployed app.
 *
 * Returns either a response the caller must send back unchanged, or an identity
 * (possibly null) to proxy the request with.
 */
export async function applyAuthGate(
  req: Request,
  app: GateApp,
  deps: GateDeps,
): Promise<GateOutcome> {
  const env = deps.env ?? process.env;
  const secure = deps.secureCookies ?? true;
  const url = new URL(req.url);
  const path = url.pathname;
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || url.host;
  const needsLogin = app.authMode === "platform";

  // The gateway's own paths are claimed even on an app with no wall. Handing
  // them to the app would let a user's route impersonate the callback and mint
  // itself a session cookie.
  if (isGatewayPath(path)) {
    const origin = currentOrigin(app, env, host);
    if (!origin) return answered(misconfigured("未配置应用域名"));
    if (path === APP_AUTH_LOGOUT_PATH) {
      return answered(handleLogout(app, origin, env, secure));
    }
    if (!needsLogin) return answered(redirect(`${origin}/`));
    if (!loginDomain(env)) return answered(misconfigured("未配置登录域名"));
    return answered(await handleCallback(url, req, app, origin, env, secure));
  }

  if (!needsLogin) return PROCEED_ANONYMOUS;

  const origin = currentOrigin(app, env, host);
  if (!origin) return answered(misconfigured("未配置应用域名"));
  if (!loginDomain(env)) return answered(misconfigured("未配置登录域名"));

  const protectedPath = pathRequiresLogin(url.pathname, app.authScope, app.authRules);

  const session = await verifyAppSession(
    readCookie(req.headers.get("cookie"), APP_COOKIE) ?? "",
    app.id,
  );

  // Admission is decided before it is acted on, because a public path and a
  // protected one need the SAME answer to "may this person be named to the
  // app" — they only differ in what happens when the answer is no.
  const admission = session ? await admit(session, app, deps) : { ok: false, denial: "anonymous" as const, orgId: null };

  if (!protectedPath) {
    // Public path. Anyone may read it; the identity headers still ride along
    // when — and only when — the visitor would have been admitted anyway, so
    // `X-Teamclu-User-Id` keeps exactly one meaning everywhere it appears:
    // this person satisfies every condition for entering this app.
    if (!admission.ok || !session) return PROCEED_ANONYMOUS;
    return {
      response: null,
      identity: { userId: session.sub, email: session.email, orgId: admission.orgId },
      setCookie: await renewalCookie(session, app, secure),
    };
  }

  if (!session) {
    const next = safeNext(`${url.pathname}${url.search}`);
    return answered(redirect(loginUrl(app, origin, next, env)));
  }
  if (admission.denial === "no_app_org") {
    return answered(misconfigured("该应用所属团队未关联组织"));
  }
  if (admission.denial === "wrong_org") {
    return answered(wrongOrgPage(app, origin, session.email));
  }

  return {
    response: null,
    identity: { userId: session.sub, email: session.email, orgId: admission.orgId },
    setCookie: await renewalCookie(session, app, secure),
  };
}

type Admission = {
  ok: boolean;
  denial: "none" | "anonymous" | "wrong_org" | "no_app_org";
  orgId: string | null;
};

/**
 * Whether a signed-in visitor meets this app's audience.
 *
 * Unset `authAudience` reads as `org`, matching the column default: a row that
 * predates the column, or a lookup that failed to select it, must not silently
 * widen the audience to everyone with an account.
 */
async function admit(
  session: { sub: string; email: string },
  app: GateApp,
  deps: GateDeps,
): Promise<Admission> {
  if ((app.authAudience ?? "org") !== "org") {
    return { ok: true, denial: "none", orgId: null };
  }
  const orgs = await deps.resolveOrgs(session.sub, app.teamId);
  // A team with no org cannot admit anyone under this audience — the comparison
  // has nothing to succeed against. That is a configuration fault (R10), not a
  // rejected visitor, and saying so is what stops an operator from hunting for
  // a permissions bug that is not there.
  if (!orgs.appOrgId) return { ok: false, denial: "no_app_org", orgId: null };
  if (!orgs.visitorOrgId || orgs.visitorOrgId !== orgs.appOrgId) {
    return { ok: false, denial: "wrong_org", orgId: null };
  }
  return { ok: true, denial: "none", orgId: orgs.visitorOrgId };
}

/**
 * Sliding renewal. Without it a session that expires mid-visit bounces the
 * request to the login domain — harmless for a GET, but it turns an in-flight
 * form POST into a GET and loses the body. Renewing while the visitor is active
 * means that only happens to someone who was away for a week.
 */
async function renewalCookie(
  session: { sub: string; email: string; expiresAt: number },
  app: GateApp,
  secure: boolean,
): Promise<string | null> {
  if (!shouldRenew(session.expiresAt)) return null;
  const fresh = await mintAppSession({ sub: session.sub, email: session.email, appId: app.id });
  return serializeSessionCookie(APP_COOKIE, fresh.token, APP_TTL_SECONDS, secure);
}
