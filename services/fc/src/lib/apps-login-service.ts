import { appOrigins } from "./apps-public-host.js";
import { esc, page, redirect, safeNext } from "./apps-auth-page.js";
import {
  APP_AUTH_CALLBACK_PATH,
  SSO_COOKIE,
  SSO_TTL_SECONDS,
  clearSessionCookie,
  mintAuthCode,
  mintSsoSession,
  readCookie,
  serializeSessionCookie,
  verifySsoSession,
} from "./apps-auth-session.js";
import { isRateLimited, resolveClientIp } from "./rate-limit.js";

/**
 * The central login service for deployed apps
 * (`docs/specs/2026-09-08-apps-login-and-custom-domain-design.md` §4.3-§4.4).
 *
 * It answers on one hostname — `LOGIN_DOMAIN` — and owns the entire login
 * experience: the page, the email round trip, and the SSO cookie. Apps never
 * see any of it. What crosses back to an app's own hostname is a single
 * one-shot code, because a cookie set here cannot be read on
 * `app.example.com`, and once custom domains exist that is the common case
 * rather than the exception.
 *
 * Holding a valid SSO cookie is what makes the second app skip the login page:
 * `GET /` mints a code immediately and bounces, so the visitor sees two
 * redirects and no form.
 *
 * The whole flow is plain `<form>` POSTs with no JavaScript. An app's login
 * wall that depends on a script bundle is a login wall that fails closed on a
 * bad network — and there is nothing here that needs a script.
 */

export type LoginApp = {
  id: string;
  slug: string;
  /** `apps.auth_mode`. Only `platform` has a login wall at all. */
  authMode: string;
};

export type LookupLoginApp = (appId: string) => Promise<LoginApp | null>;

export type LoginServiceDeps = {
  lookupApp: LookupLoginApp;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** False only on a plain-http local box; every real deploy terminates TLS. */
  secureCookies?: boolean;
  /** Seam so tests can drive the limiter deterministically. */
  rateLimited?: (key: string, max: number) => boolean;
};

/** Verification codes per IP+email per minute. GoTrue also limits sending. */
const OTP_RATE_LIMIT = 5;

// ---------------------------------------------------------------------------
// Request context: everything the four handlers need, validated once.
// ---------------------------------------------------------------------------

type LoginContext = {
  app: LoginApp;
  /** Origin the code will be redeemed on. Always one this app really answers on. */
  origin: string;
  /** Path inside the app to land on. Always starts with a single `/`. */
  next: string;
};

/**
 * Resolve where the visitor gets sent back to.
 *
 * A caller-supplied `r` must match one of this app's own origins exactly. It is
 * NOT silently replaced when it does not: this parameter is the entire attack
 * surface of the login service (R9), and quietly rewriting a bad value would
 * hide the bug that produced it while teaching nobody. Absent `r`, the app's
 * canonical origin is used — that value is computed here, never supplied.
 */
function resolveOrigin(
  app: LoginApp,
  raw: string | null,
  env: NodeJS.ProcessEnv,
): { origin: string } | { error: string } {
  const allowed = appOrigins(app, env);
  if (allowed.length === 0) {
    return { error: "这个部署没有配置应用域名，无法完成登录。" };
  }
  if (!raw) return { origin: allowed[0] };
  const wanted = raw.replace(/\/+$/, "");
  return allowed.includes(wanted)
    ? { origin: wanted }
    : { error: "登录请求的返回地址与该应用不符。" };
}

function looksLikeEmail(value: string): boolean {
  if (value.length < 3 || value.length > 254) return false;
  const at = value.indexOf("@");
  return at > 0 && at === value.lastIndexOf("@") && at < value.length - 1;
}

async function loadContext(
  params: URLSearchParams,
  deps: LoginServiceDeps,
  env: NodeJS.ProcessEnv,
): Promise<LoginContext | { error: string; status: number }> {
  const appId = params.get("app")?.trim() ?? "";
  if (!appId) return { error: "缺少应用参数。", status: 400 };

  const app = await deps.lookupApp(appId);
  // Same answer for "no such app" and "this app has no login": the login
  // service is unauthenticated, and telling them apart would turn it into an
  // app-existence oracle for anyone who can guess ids.
  if (!app || app.authMode !== "platform") {
    return { error: "找不到这个应用，或它没有开启登录。", status: 404 };
  }

  const resolved = resolveOrigin(app, params.get("r"), env);
  if ("error" in resolved) return { error: resolved.error, status: 400 };

  return { app, origin: resolved.origin, next: safeNext(params.get("next")) };
}

// ---------------------------------------------------------------------------
// GoTrue
// ---------------------------------------------------------------------------

/**
 * Flat rather than a discriminated union on purpose: this package compiles with
 * `strict: false`, and without `strictNullChecks` TypeScript will not narrow a
 * union by its discriminant — `if (!result.ok)` leaves every branch-only field
 * unreachable. One shape with every field always present is what actually
 * type-checks here.
 */
type GotrueResult = {
  kind: "ok" | "rejected" | "unavailable";
  body: any;
  /** Visitor-facing text; only set for `unavailable`. */
  message: string;
};

/**
 * Internal Supabase URL on purpose — the login service talks to GoTrue over
 * the compose network, not back out through the public hostname.
 */
function gotrueBase(env: NodeJS.ProcessEnv): string {
  return (env.SUPABASE_URL || env.SUPABASE_PUBLIC_URL || "").trim().replace(/\/+$/, "");
}

function anonKey(env: NodeJS.ProcessEnv): string {
  return (env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "").trim();
}

/**
 * `rejected` is the visitor's fault (bad code, refused address) and is safe to
 * act on; `unavailable` is ours. They are separated here so no caller has to
 * interpret an HTTP status, and so GoTrue's own wording never reaches the page
 * — upstream error text can name internals and is written for operators.
 */
async function callGotrue(
  path: string,
  body: Record<string, unknown>,
  deps: LoginServiceDeps,
  env: NodeJS.ProcessEnv,
): Promise<GotrueResult> {
  const base = gotrueBase(env);
  const key = anonKey(env);
  if (!base || !key) {
    return { kind: "unavailable", body: null, message: "登录服务尚未配置。" };
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: "unavailable", body: null, message: "登录服务暂时不可用，请稍后再试。" };
  }

  const text = await res.text().catch(() => "");
  let parsed: any = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (res.ok) return { kind: "ok", body: parsed ?? {}, message: "" };
  if (res.status >= 500) {
    return { kind: "unavailable", body: null, message: "登录服务暂时不可用，请稍后再试。" };
  }
  return { kind: "rejected", body: parsed, message: "" };
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/** The hidden fields that carry the flow across two form posts. */
function carried(ctx: LoginContext): string {
  return (
    `<input type="hidden" name="app" value="${esc(ctx.app.id)}">` +
    `<input type="hidden" name="r" value="${esc(ctx.origin)}">` +
    `<input type="hidden" name="next" value="${esc(ctx.next)}">`
  );
}

function errorBlock(message: string): string {
  return message ? `<p class="err">${esc(message)}</p>` : "";
}

function emailPage(ctx: LoginContext, email = "", error = "", status = 200): Response {
  return page(
    "登录",
    `<h1>登录</h1><p class="sub">继续访问需要先验证你的邮箱。</p>` +
      errorBlock(error) +
      `<form method="post" action="/otp">${carried(ctx)}` +
      `<label for="email">邮箱</label>` +
      `<input id="email" name="email" type="email" inputmode="email" autocomplete="email" ` +
      `autofocus required value="${esc(email)}">` +
      `<button type="submit">发送验证码</button></form>`,
    status,
  );
}

function codePage(ctx: LoginContext, email: string, error = "", status = 200): Response {
  return page(
    "输入验证码",
    `<h1>输入验证码</h1><p class="sub">验证码已发送到 ${esc(email)}。</p>` +
      errorBlock(error) +
      `<form method="post" action="/verify">${carried(ctx)}` +
      `<input type="hidden" name="email" value="${esc(email)}">` +
      `<label for="code">验证码</label>` +
      `<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" ` +
      `class="code-input" autofocus required maxlength="10">` +
      `<button type="submit">登录</button></form>` +
      `<p class="foot"><a href="/?app=${encodeURIComponent(ctx.app.id)}` +
      `&amp;r=${encodeURIComponent(ctx.origin)}&amp;next=${encodeURIComponent(ctx.next)}">换一个邮箱</a></p>`,
    status,
  );
}

function noticePage(message: string, status: number): Response {
  return page("登录", `<h1>无法继续</h1><p class="sub">${esc(message)}</p>`, status);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** Hand the visitor back to the app with a code it can exchange for a session. */
async function bounceWithCode(
  ctx: LoginContext,
  user: { sub: string; email: string },
  cookies: string[] = [],
): Promise<Response> {
  const { token } = await mintAuthCode({
    sub: user.sub,
    email: user.email,
    appId: ctx.app.id,
    redirect: ctx.origin,
  });
  const target =
    `${ctx.origin}${APP_AUTH_CALLBACK_PATH}` +
    `?code=${encodeURIComponent(token)}&next=${encodeURIComponent(ctx.next)}`;
  return redirect(target, cookies);
}

async function handleRoot(
  url: URL,
  req: Request,
  deps: LoginServiceDeps,
  env: NodeJS.ProcessEnv,
): Promise<Response> {
  // No app parameter: someone opened the login domain directly. Say where they
  // are rather than 404 — this hostname is a real thing they can bookmark.
  if (!url.searchParams.get("app")) {
    const session = await verifySsoSession(readCookie(req.headers.get("cookie"), SSO_COOKIE) ?? "");
    return page(
      "登录",
      session
        ? `<h1>已登录</h1><p class="sub">当前账号 ${esc(session.email)}。` +
            `请从应用的地址进入。</p>` +
            `<form method="post" action="/logout"><button type="submit">退出登录</button></form>`
        : `<h1>登录</h1><p class="sub">请从你要访问的应用地址进入，这里会引导你完成登录。</p>`,
    );
  }

  const ctx = await loadContext(url.searchParams, deps, env);
  if ("error" in ctx) return noticePage(ctx.error, ctx.status);

  // The SSO shortcut. This branch is the whole point of a central login
  // service: the second app a visitor opens costs them two redirects and no
  // typing.
  const session = await verifySsoSession(readCookie(req.headers.get("cookie"), SSO_COOKIE) ?? "");
  if (session) return bounceWithCode(ctx, session);

  return emailPage(ctx);
}

async function handleOtp(
  form: URLSearchParams,
  req: Request,
  deps: LoginServiceDeps,
  env: NodeJS.ProcessEnv,
): Promise<Response> {
  const ctx = await loadContext(form, deps, env);
  if ("error" in ctx) return noticePage(ctx.error, ctx.status);

  const email = (form.get("email") ?? "").trim().toLowerCase();
  if (!looksLikeEmail(email)) {
    return emailPage(ctx, email, "请填写一个有效的邮箱地址。", 400);
  }

  // Per IP AND per address: keying on one alone lets an attacker either mail
  // one victim from many hosts, or many victims from one.
  const limiter = deps.rateLimited ?? isRateLimited;
  const { ip } = resolveClientIp((n) => req.headers.get(n) ?? undefined);
  if (limiter(`apps-login:otp:${ip ?? "unknown"}:${email}`, OTP_RATE_LIMIT)) {
    return emailPage(ctx, email, "尝试过于频繁，请等一分钟再试。", 429);
  }

  const result = await callGotrue("/auth/v1/otp", { email, create_user: true }, deps, env);
  if (result.kind !== "ok") {
    const down = result.kind === "unavailable";
    return emailPage(
      ctx,
      email,
      down ? result.message : "这个邮箱地址无法接收验证码。",
      down ? 503 : 400,
    );
  }
  return codePage(ctx, email);
}

async function handleVerify(
  form: URLSearchParams,
  deps: LoginServiceDeps,
  env: NodeJS.ProcessEnv,
  secure: boolean,
): Promise<Response> {
  const ctx = await loadContext(form, deps, env);
  if ("error" in ctx) return noticePage(ctx.error, ctx.status);

  const email = (form.get("email") ?? "").trim().toLowerCase();
  const code = (form.get("code") ?? "").trim();
  if (!looksLikeEmail(email)) return emailPage(ctx, email, "请重新输入邮箱地址。", 400);
  if (!code) return codePage(ctx, email, "请输入验证码。", 400);

  const result = await callGotrue(
    "/auth/v1/verify",
    { type: "email", email, token: code },
    deps,
    env,
  );
  if (result.kind !== "ok") {
    const down = result.kind === "unavailable";
    return codePage(
      ctx,
      email,
      down ? result.message : "验证码不正确或已过期。",
      down ? 503 : 400,
    );
  }

  const sub = typeof result.body?.user?.id === "string" ? result.body.user.id : "";
  const verifiedEmail =
    typeof result.body?.user?.email === "string" ? result.body.user.email : email;
  if (!sub) {
    // GoTrue answered 200 without a user. Treat as unavailable rather than
    // minting a session with no subject to bind it to.
    return codePage(ctx, email, "登录服务暂时不可用，请稍后再试。", 503);
  }

  const sso = await mintSsoSession({ sub, email: verifiedEmail });
  const cookie = serializeSessionCookie(SSO_COOKIE, sso.token, SSO_TTL_SECONDS, secure);
  return bounceWithCode(ctx, { sub, email: verifiedEmail }, [cookie]);
}

function handleLogout(secure: boolean): Response {
  return redirect("/", [clearSessionCookie(SSO_COOKIE, secure)]);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Handle a request addressed to the login hostname, or return null to let the
 * rest of the API see it (so `/healthz` and friends still work here).
 */
export async function handleLoginRequest(
  req: Request,
  deps: LoginServiceDeps,
): Promise<Response | null> {
  const env = deps.env ?? process.env;
  const secure = deps.secureCookies ?? true;
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && path === "/") return handleRoot(url, req, deps, env);

  if (req.method === "POST" && (path === "/otp" || path === "/verify" || path === "/logout")) {
    if (path === "/logout") return handleLogout(secure);
    // Deliberately not req.formData(): these forms are urlencoded, and
    // URLSearchParams cannot be talked into multipart parsing by a caller.
    const form = new URLSearchParams(await req.text());
    return path === "/otp"
      ? handleOtp(form, req, deps, env)
      : handleVerify(form, deps, env, secure);
  }

  // Logout answers on GET too, and really does clear the cookie.
  //
  // An app's gateway hands the visitor here with a 302, which is necessarily a
  // GET; a logout that left the SSO cookie alive would not be a logout at all,
  // since the very next app request would be signed straight back in. Being
  // reachable by a forged GET means a third party can log someone out — a
  // nuisance, not a breach, and the trade every site with a /logout link makes.
  if (req.method === "GET" && path === "/logout") {
    const res = page(
      "已退出",
      `<h1>已退出</h1><p class="sub">你已从所有应用退出登录。</p>`,
    );
    res.headers.append("Set-Cookie", clearSessionCookie(SSO_COOKIE, secure));
    return res;
  }

  // A GET to the other POST-only paths is a stale bookmark or a back button,
  // not an error worth a status code — send them to the start of the flow.
  if (req.method === "GET" && (path === "/otp" || path === "/verify")) {
    return redirect("/");
  }

  return null;
}

/** True when this request is addressed to the configured login hostname. */
export function isLoginHost(host: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const domain = env.LOGIN_DOMAIN?.trim().toLowerCase();
  if (!domain || !host) return false;
  return host.split(":")[0].trim().toLowerCase() === domain;
}
