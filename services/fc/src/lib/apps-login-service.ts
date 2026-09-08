import { appPublicUrl } from "./apps-public-host.js";
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
 * Every origin this app is reachable on.
 *
 * Batch 4 adds the verified custom domain to this list; until then it is the
 * vanity host alone. Keeping it a list from the start is what stops the
 * redirect check from being rewritten later — the only thing that changes is
 * where the entries come from.
 */
function allowedOrigins(app: LoginApp, env: NodeJS.ProcessEnv): string[] {
  const vanity = appPublicUrl(app.slug, app.id, env);
  return vanity ? [vanity] : [];
}

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
  const allowed = allowedOrigins(app, env);
  if (allowed.length === 0) {
    return { error: "这个部署没有配置应用域名，无法完成登录。" };
  }
  if (!raw) return { origin: allowed[0] };
  const wanted = raw.replace(/\/+$/, "");
  return allowed.includes(wanted)
    ? { origin: wanted }
    : { error: "登录请求的返回地址与该应用不符。" };
}

/**
 * A path inside the app, never a way out of it.
 *
 * `//evil.example.com` is a protocol-relative URL that browsers treat as
 * another site, and a backslash is folded to `/` by several of them — so both
 * are rejected rather than escaped.
 */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.includes("\\")) return "/";
  return raw;
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

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * One stylesheet for every page here. Inline because this document is served
 * from a bare hostname with no asset pipeline behind it, and a login page that
 * waits on a second request is a login page that flashes unstyled.
 */
const PAGE_CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--ink:#15181e;--muted:#6c7688;--line:#d9dee6;--accent:#2f5d8c;--err:#973340}
@media(prefers-color-scheme:dark){:root{--bg:#101318;--card:#171b22;--ink:#e8ebf0;--muted:#7d879a;--line:#2b323d;--accent:#7fb0dd;--err:#d98a95}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
background:var(--bg);color:var(--ink);
font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
.card{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:32px 28px}
h1{margin:0 0 6px;font-size:19px;font-weight:600;letter-spacing:-.01em}
p.sub{margin:0 0 22px;color:var(--muted);font-size:13.5px}
label{display:block;font-size:12.5px;color:var(--muted);margin-bottom:6px}
input{width:100%;height:40px;padding:0 12px;font:inherit;font-size:15px;color:var(--ink);
background:var(--bg);border:1px solid var(--line);border-radius:7px}
input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
button{width:100%;height:40px;margin-top:16px;font:inherit;font-size:14.5px;font-weight:500;
color:#fff;background:var(--accent);border:0;border-radius:7px;cursor:pointer}
button:hover{filter:brightness(1.08)}
.err{margin:0 0 16px;padding:9px 12px;border-radius:7px;font-size:13px;
color:var(--err);border:1px solid currentColor;background:transparent}
.foot{margin:18px 0 0;font-size:12px;color:var(--muted);text-align:center}
.code-input{letter-spacing:.4em;font-variant-numeric:tabular-nums}
`;

function page(title: string, inner: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${esc(title)}</title><style>${PAGE_CSS}</style></head>` +
      `<body><main class="card">${inner}</main></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // A login page must never be cached: the next visitor on a shared
        // machine would get the previous one's form state back.
        "Cache-Control": "no-store",
        "Referrer-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

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

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

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

  // A GET to a POST-only path is a stale bookmark or a back button, not an
  // error worth a status code — send them to the start of the flow.
  if (req.method === "GET" && (path === "/otp" || path === "/verify" || path === "/logout")) {
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
