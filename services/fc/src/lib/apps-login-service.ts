import { createHash, randomBytes } from "node:crypto";

import { appOrigins } from "./apps-public-host.js";
import { esc, mark, page, redirect, safeNext, statusIcon, type PageApp } from "./apps-auth-page.js";
import {
  APP_AUTH_CALLBACK_PATH,
  LOGIN_STATE_COOKIE,
  LOGIN_STATE_TTL_SECONDS,
  SSO_COOKIE,
  SSO_TTL_SECONDS,
  clearSessionCookie,
  mintLoginState,
  mintAuthCode,
  mintSsoSession,
  readCookie,
  serializeSessionCookie,
  verifyLoginState,
  verifySsoSession,
} from "./apps-auth-session.js";
import { appAdmitsAnyAudience } from "./apps-auth-paths.js";
import { isRateLimited, resolveClientIp } from "./rate-limit.js";
import { resolveFeatures } from "./routes/config.js";

/**
 * The central login service for deployed apps
 * (`docs/specs/2026-09-08-apps-login-and-custom-domain-design.md` §4.3-§4.4).
 *
 * It answers on one hostname — `LOGIN_DOMAIN` — and owns the entire login
 * experience: the page, the email/password/phone round trips, configured
 * OAuth, and the SSO cookie. Apps never see any of it. What crosses back to an app's
 * own hostname is a single one-shot code, because a cookie set here cannot be
 * read on `app.example.com`, and once custom domains exist that is the common
 * case rather than the exception.
 *
 * Holding a valid SSO cookie is what makes the second app skip the login page:
 * `GET /` mints a code immediately and bounces, so the visitor sees two
 * redirects and no form.
 *
 * Which methods the page offers is not decided here: it is the same
 * `features.auth` block `/v1/config/public` hands the desktop login screen, so
 * turning Google off or phone on changes both at once. Email has no flag on
 * either side and is always offered. Web SSO is not offered at all — it is a
 * desktop sign-in path, not one for an app's visitors.
 *
 * Every step is a plain `<form>` POST or a redirect.
 */

export type LoginApp = {
  id: string;
  slug: string;
  /**
   * `apps.name`. Every page names the app so the visitor can tell what is
   * asking them to sign in; the slug stands in when it is blank.
   */
  name?: string | null;
  /** Name of the app's team, shown beside it. Null when it could not be read. */
  teamName?: string | null;
  /** `apps.auth_mode`. Only `platform` has a login wall at all. */
  authMode: string;
  /**
   * `apps.org_id` — the tenant this login page belongs to.
   *
   * Every identity decision on this page is narrowed to it. Without it the
   * page had no idea which tenant was asking, so it offered a phone number's
   * identity in EVERY org and the gateway rejected the wrong pick afterwards.
   */
  orgId?: string | null;
  /** `apps.auth_audience` / `auth_scope` / `auth_rules` — read together, and
   * only to answer whether this app invites the public
   * (see {@link appAdmitsAnyAudience}). */
  authAudience?: string | null;
  authScope?: string | null;
  authRules?: unknown;
  /** `apps.custom_domain`. A valid return origin only once verified. */
  customDomain?: string | null;
  /**
   * `apps.custom_domain_verified_at` — null means stored but NOT served, so
   * not a return origin either.
   */
  customDomainVerifiedAt?: string | null;
};

export type LookupLoginApp = (appId: string) => Promise<LoginApp | null>;

/**
 * Columns the login service reads from `amux.apps`.
 *
 * The custom-domain pair is here because the return address a visitor arrives
 * with is checked against `appOrigins`, and a verified custom domain is one of
 * those origins. The gateway reads the same two columns when it builds that
 * address (`apps-vanity.ts`); without them here, every login started on a
 * custom domain was refused as "返回地址与该应用不符".
 */
const LOGIN_APP_COLUMNS =
  "id, slug, name, team_id, org_id, auth_mode, auth_audience, auth_scope, auth_rules, custom_domain, custom_domain_verified_at";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The app lookup, reading with a service-role client.
 *
 * Takes the client factory instead of importing it so the column list and the
 * row mapping are testable without a database — the same seam
 * `makeSupabaseVanityLookup` uses. The bug this exists to prevent was exactly
 * a column the mapping never read.
 */
export function makeSupabaseLoginAppLookup(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getClient: () => any,
): LookupLoginApp {
  return async (appId: string) => {
    if (!UUID_RE.test(appId)) return null;
    const client = getClient();
    const { data, error } = await client
      .from("apps")
      .select(LOGIN_APP_COLUMNS)
      .eq("id", appId)
      .maybeSingle();
    if (error) throw new Error(`login app lookup failed: ${error.message}`);
    if (!data) return null;
    return {
      id: data.id,
      slug: data.slug,
      name: data.name ?? null,
      teamName: await readTeamName(client, data.team_id ?? null),
      authMode: data.auth_mode ?? "none",
      orgId: data.org_id ?? null,
      authAudience: data.auth_audience ?? null,
      authScope: data.auth_scope ?? null,
      authRules: data.auth_rules ?? null,
      customDomain: data.custom_domain ?? null,
      customDomainVerifiedAt: data.custom_domain_verified_at ?? null,
    };
  };
}

/**
 * The team caption on the login page. Best effort, on purpose: it is a label,
 * and a failed read must not become a login page that refuses to render.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readTeamName(client: any, teamId: string | null): Promise<string | null> {
  if (!teamId) return null;
  try {
    const { data } = await client.from("teams").select("name").eq("id", teamId).maybeSingle();
    return typeof data?.name === "string" && data.name.trim() ? data.name.trim() : null;
  } catch {
    return null;
  }
}

export type LoginServiceDeps = {
  lookupApp: LookupLoginApp;
  /** The same auth repository used by /v1/auth/*, needed for phone login. */
  createAuthRepository?: () => unknown | Promise<unknown>;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** False only on a plain-http local box; every real deploy terminates TLS. */
  secureCookies?: boolean;
  /** Seam so tests can drive the limiter deterministically. */
  rateLimited?: (key: string, max: number) => boolean;
};

/** Verification codes per IP+email per minute. GoTrue also limits sending. */
const OTP_RATE_LIMIT = 5;
const PHONE_OTP_RATE_LIMIT = 3;
/** Password attempts per IP+email per minute. GoTrue limits behind this too. */
const PASSWORD_RATE_LIMIT = 10;
const OAUTH_CALLBACK_PATH = "/oauth/callback";

type OAuthProvider = "google" | "wechat";
/** Methods filled in on this page, as opposed to handed off to a provider. */
type CredentialMethod = "email" | "password" | "phone";
/** Methods behind a `features.auth` flag. Email has none. */
type FlaggedMethod = "password" | "phone" | OAuthProvider;

type PhoneLoginUser = {
  id: string;
  org_id?: string | null;
  org_name?: string | null;
  /** `public.users.admin_type`: 1 = member, >= 2 = staff. */
  admin_type?: number;
  nickname?: string | null;
  email?: string | null;
};

type PhoneAuthRepository = {
  phoneSendCode: (args: { phone: string; captchaVerify?: string }) => Promise<unknown>;
  phoneLogin: (args: {
    phone: string;
    code: string;
    userId?: string;
    tenantOrgId?: string;
    allowSignup?: boolean;
  }) => Promise<unknown>;
};

// ---------------------------------------------------------------------------
// Request context: everything the login flow handlers need, validated once.
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

function publicGotrueBase(env: NodeJS.ProcessEnv): string {
  return (env.SUPABASE_PUBLIC_URL || env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
}

function loginOrigin(req: Request, secure: boolean, env: NodeJS.ProcessEnv): string {
  // The request has already passed the LOGIN_DOMAIN host gate. Prefer the
  // configured value anyway: on FC the adapter URL can contain the trigger's
  // generated hostname rather than the public custom domain.
  const configured = env.LOGIN_DOMAIN?.trim();
  const host = configured || new URL(req.url).host;
  return `${secure ? "https" : "http"}://${host}`;
}

function authMethodEnabled(method: FlaggedMethod, env: NodeJS.ProcessEnv): boolean {
  const auth = resolveFeatures(env).auth;
  return auth?.[method] === true;
}

/** In tab order. Email first because it is the one method that is always there. */
function credentialMethods(env: NodeJS.ProcessEnv): CredentialMethod[] {
  const methods: CredentialMethod[] = ["email"];
  if (authMethodEnabled("password", env)) methods.push("password");
  if (authMethodEnabled("phone", env)) methods.push("phone");
  return methods;
}

function pkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function flowUrl(path: string, ctx: LoginContext, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ app: ctx.app.id, r: ctx.origin, next: ctx.next, ...extra });
  return `${path}?${params.toString()}`;
}

function userFromAuthBody(body: any, fallbackEmail = ""): { sub: string; email: string } | null {
  const user = body?.user;
  const sub = typeof user?.id === "string" ? user.id : "";
  const email =
    typeof user?.email === "string" && user.email.trim()
      ? user.email.trim().toLowerCase()
      : typeof user?.user_metadata?.email === "string" && user.user_metadata.email.trim()
        ? user.user_metadata.email.trim().toLowerCase()
        : fallbackEmail;
  return sub && email ? { sub, email } : null;
}

function authFailure(error: unknown): { status: number; message: string } {
  const statusCode = Number((error as any)?.statusCode ?? (error as any)?.status);
  if (statusCode === 429) return { status: 429, message: "尝试过于频繁，请稍后再试。" };
  if (statusCode >= 500) return { status: 503, message: "登录服务暂时不可用，请稍后再试。" };
  const message = typeof (error as any)?.message === "string" ? (error as any).message : "登录失败，请稍后再试。";
  return { status: statusCode >= 400 && statusCode < 500 ? statusCode : 400, message };
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
  return message ? `<p class="err" role="alert">${esc(message)}</p>` : "";
}

function noteBlock(message: string): string {
  return message ? `<p class="note" role="status">${esc(message)}</p>` : "";
}

function appName(app: LoginApp): string {
  return app.name?.trim() || app.slug;
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** A page inside the flow for a known app, which the shell names in its corner. */
function appPage(ctx: LoginContext, title: string, inner: string, status = 200): Response {
  const app: PageApp = { id: ctx.app.id, name: appName(ctx.app) };
  return page(title, inner, status, { app });
}

function startHeading(ctx: LoginContext): string {
  return `<p class="eyebrow">访问 <strong>${esc(appName(ctx.app))}</strong> 需要先登录</p><h1>登录账号</h1>`;
}

const CREDENTIAL_LABELS: Record<CredentialMethod, string> = {
  email: "邮箱登录",
  password: "密码登录",
  phone: "手机号登录",
};

function methodUrl(ctx: LoginContext, method: CredentialMethod): string {
  return flowUrl("/", ctx, method === "email" ? {} : { method });
}

/** Only drawn when there is a choice to make; a single method needs no tabs. */
function methodTabs(ctx: LoginContext, env: NodeJS.ProcessEnv, current: CredentialMethod): string {
  const methods = credentialMethods(env);
  if (methods.length < 2) return "";
  const tabs = methods.map(
    (method) =>
      `<a href="${esc(methodUrl(ctx, method))}"${method === current ? ` aria-current="page"` : ""}>` +
      `${CREDENTIAL_LABELS[method]}</a>`,
  );
  return `<nav class="tabs" aria-label="登录方式">${tabs.join("")}</nav>`;
}

const GOOGLE_ICON =
  `<svg viewBox="0 0 24 24" aria-hidden="true">` +
  `<path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z"/>` +
  `<path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.57-2.77c-.99.66-2.26 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"/>` +
  `<path fill="#FBBC05" d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84Z"/>` +
  `<path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.05l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z"/>` +
  `</svg>`;

const WECHAT_ICON =
  `<svg viewBox="0 0 24 24" fill="#07C160" aria-hidden="true">` +
  `<path d="M8.69 4C4.86 4 1.75 6.61 1.75 9.83c0 1.8.98 3.41 2.52 4.49l-.63 1.9 2.2-1.1c.79.22 1.6.36 2.45.4-.1-.43-.16-.87-.16-1.32 0-3.05 2.96-5.4 6.46-5.4.23 0 .46.02.68.04C14.9 5.77 12.07 4 8.69 4Zm-2.3 3.1a.86.86 0 1 1 0 1.72.86.86 0 0 1 0-1.72Zm4.6 0a.86.86 0 1 1 0 1.72.86.86 0 0 1 0-1.72Z"/>` +
  `<path d="M22.25 14.07c0-2.7-2.62-4.9-5.85-4.9-3.34 0-5.86 2.32-5.86 4.96 0 2.65 2.52 4.9 5.86 4.9.72 0 1.42-.12 2.07-.32l1.86.93-.52-1.6c1.45-.94 2.44-2.36 2.44-3.97Zm-7.74-1.06a.72.72 0 1 1 0-1.44.72.72 0 0 1 0 1.44Zm3.78 0a.72.72 0 1 1 0-1.44.72.72 0 0 1 0 1.44Z"/>` +
  `</svg>`;

function providerButtons(ctx: LoginContext, env: NodeJS.ProcessEnv): string {
  const buttons: string[] = [];
  if (authMethodEnabled("google", env)) {
    buttons.push(
      `<a class="btn btn-outline" href="${esc(flowUrl("/oauth/google", ctx))}">${GOOGLE_ICON}<span>使用 Google 登录</span></a>`,
    );
  }
  // Keep this in lock-step with the Tauri auth config. WeChat is not enabled
  // by the shipped profiles, but a deployment that turns it on gets the same
  // provider here as well.
  if (authMethodEnabled("wechat", env)) {
    buttons.push(
      `<a class="btn btn-outline" href="${esc(flowUrl("/oauth/wechat", ctx))}">${WECHAT_ICON}<span>使用微信登录</span></a>`,
    );
  }
  return buttons.length ? `<div class="divider">或</div><div class="alt">${buttons.join("")}</div>` : "";
}

/**
 * What the visitor is agreeing to, at the point they agree to it: which app,
 * whose, where they land afterwards, and what the app learns about them. The
 * host is `ctx.origin`, which has already been matched against the app's own
 * origins, so it is the address the visitor will really be sent back to.
 */
function consent(ctx: LoginContext): string {
  const name = appName(ctx.app);
  const team = ctx.app.teamName?.trim();
  return (
    `<div class="consent"><div class="consent-app">${mark(ctx.app.id, name, "mark mark-sm")}` +
    `<div class="consent-who"><strong>${esc(name)}</strong>` +
    (team ? `<span>${esc(team)}</span>` : "") +
    `<span class="host">${esc(hostOf(ctx.origin))}</span></div></div>` +
    `<p>登录后将返回该应用，应用会获得你的账号 ID 和邮箱地址。</p></div>`
  );
}

function emailPage(
  ctx: LoginContext,
  env: NodeJS.ProcessEnv,
  email = "",
  error = "",
  status = 200,
): Response {
  return appPage(
    ctx,
    "登录",
    startHeading(ctx) +
      methodTabs(ctx, env, "email") +
      errorBlock(error) +
      `<form method="post" action="/otp">${carried(ctx)}` +
      `<label class="field"><span class="sr">邮箱地址</span>` +
      `<input name="email" type="email" inputmode="email" autocomplete="email" placeholder="邮箱地址" ` +
      `autofocus required value="${esc(email)}"></label>` +
      `<button class="btn btn-primary" type="submit">发送验证码</button></form>` +
      providerButtons(ctx, env) +
      consent(ctx),
    status,
  );
}

function passwordPage(
  ctx: LoginContext,
  env: NodeJS.ProcessEnv,
  email = "",
  error = "",
  status = 200,
): Response {
  // Focus lands where the typing starts: the address, or the password when
  // the address came back with an error attached.
  return appPage(
    ctx,
    "密码登录",
    startHeading(ctx) +
      methodTabs(ctx, env, "password") +
      errorBlock(error) +
      `<form method="post" action="/password">${carried(ctx)}` +
      `<label class="field"><span class="sr">邮箱地址</span>` +
      `<input name="email" type="email" inputmode="email" autocomplete="username" placeholder="邮箱地址" ` +
      `${email ? "" : "autofocus "}required value="${esc(email)}"></label>` +
      `<label class="field"><span class="sr">密码</span>` +
      `<input name="password" type="password" autocomplete="current-password" placeholder="密码" ` +
      `${email ? "autofocus " : ""}required></label>` +
      `<button class="btn btn-primary" type="submit">登录</button></form>` +
      providerButtons(ctx, env) +
      consent(ctx),
    status,
  );
}

function codePage(ctx: LoginContext, email: string, error = "", status = 200, note = ""): Response {
  return appPage(
    ctx,
    "输入验证码",
    `<p class="eyebrow">验证码已发送至 <strong>${esc(email)}</strong></p><h1>输入验证码</h1>` +
      noteBlock(note) +
      errorBlock(error) +
      `<form method="post" action="/verify">${carried(ctx)}` +
      `<input type="hidden" name="email" value="${esc(email)}">` +
      `<label class="field"><span class="sr">验证码</span>` +
      `<input name="code" type="text" inputmode="numeric" autocomplete="one-time-code" ` +
      `class="code-input" placeholder="······" autofocus required maxlength="10"></label>` +
      `<button class="btn btn-primary" type="submit">登录</button></form>` +
      `<div class="row"><a class="link link-muted" href="${esc(flowUrl("/", ctx))}">← 换一个邮箱</a>` +
      `<form method="post" action="/otp">${carried(ctx)}` +
      `<input type="hidden" name="email" value="${esc(email)}"><input type="hidden" name="resend" value="1">` +
      `<button class="link" type="submit">重新发送</button></form></div>`,
    status,
  );
}

function phonePage(
  ctx: LoginContext,
  env: NodeJS.ProcessEnv,
  phone = "",
  error = "",
  status = 200,
): Response {
  return appPage(
    ctx,
    "手机号登录",
    startHeading(ctx) +
      methodTabs(ctx, env, "phone") +
      errorBlock(error) +
      `<form method="post" action="/phone">${carried(ctx)}` +
      `<label class="field"><span class="sr">手机号</span>` +
      `<input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="手机号，例如 +8613800138000" ` +
      `autofocus required value="${esc(phone)}"></label>` +
      `<button class="btn btn-primary" type="submit">发送验证码</button></form>` +
      providerButtons(ctx, env) +
      consent(ctx),
    status,
  );
}

function phoneCodePage(ctx: LoginContext, phone: string, error = "", status = 200, note = ""): Response {
  return appPage(
    ctx,
    "输入验证码",
    `<p class="eyebrow">验证码已发送至 <strong>${esc(phone)}</strong></p><h1>输入验证码</h1>` +
      noteBlock(note) +
      errorBlock(error) +
      `<form method="post" action="/phone/verify">${carried(ctx)}` +
      `<input type="hidden" name="phone" value="${esc(phone)}">` +
      `<label class="field"><span class="sr">验证码</span>` +
      `<input name="code" type="text" inputmode="numeric" autocomplete="one-time-code" ` +
      `class="code-input" placeholder="······" autofocus required maxlength="6" pattern="[0-9]{6}"></label>` +
      `<button class="btn btn-primary" type="submit">登录</button></form>` +
      `<div class="row"><a class="link link-muted" href="${esc(methodUrl(ctx, "phone"))}">← 换一个手机号</a>` +
      `<form method="post" action="/phone">${carried(ctx)}` +
      `<input type="hidden" name="phone" value="${esc(phone)}"><input type="hidden" name="resend" value="1">` +
      `<button class="link" type="submit">重新发送</button></form></div>`,
    status,
  );
}

/**
 * What `public.users.admin_type` means to the person choosing.
 *
 * The column is the partner's, and only the 1 / >=2 split is documented
 * (`amux.caller_employee_orgs` draws the employee line at 2), so this says no
 * more than that split supports. An unknown value gets no label at all rather
 * than a guessed one.
 */
function kindLabel(adminType: number | undefined): string {
  if (adminType === 1) return "会员";
  if (typeof adminType === "number" && adminType >= 2) return "员工";
  return "";
}

function phoneAccountPage(
  ctx: LoginContext,
  phone: string,
  code: string,
  users: PhoneLoginUser[],
  error = "",
  status = 200,
): Response {
  const choices = users
    .map((user) => {
      const label = user.nickname?.trim() || user.email?.trim() || "账号";
      // Every entry now sits in the SAME org, so the org name — which used to
      // be the whole detail line — is identical on all of them and tells the
      // visitor nothing. What actually differs is the kind of identity and the
      // email, so show those; the org name is dropped rather than repeated.
      const detail = [kindLabel(user.admin_type), user.email?.trim()]
        .filter((part): part is string => !!part)
        .join(" · ");
      return (
        `<button class="account" type="submit" name="userId" value="${esc(user.id)}">` +
        `${mark(user.id, label, "mark mark-sm")}` +
        `<span class="who"><strong>${esc(label)}</strong>${detail ? `<small>${esc(detail)}</small>` : ""}</span></button>`
      );
    })
    .join("");
  return appPage(
    ctx,
    "选择账号",
    `<p class="eyebrow">手机号 <strong>${esc(phone)}</strong> 关联了多个账号</p><h1>选择要登录的账号</h1>` +
      errorBlock(error) +
      `<form method="post" action="/phone/select">${carried(ctx)}` +
      `<input type="hidden" name="phone" value="${esc(phone)}">` +
      `<input type="hidden" name="code" value="${esc(code)}">` +
      `<div class="account-choices">${choices}</div></form>` +
      `<p class="foot"><a class="link link-muted" href="${esc(methodUrl(ctx, "phone"))}">使用其他手机号</a></p>`,
    status,
  );
}

/**
 * A dead end with no app to name — the request itself did not identify one we
 * may render. Deliberately app-free, so "no such app" and "no login on this
 * app" stay byte-identical.
 */
function noticePage(message: string, status: number): Response {
  return page("无法继续", `${statusIcon("warn")}<h1>无法继续</h1><p class="sub">${esc(message)}</p>`, status);
}

function retryPage(ctx: LoginContext, message: string, status: number): Response {
  return appPage(
    ctx,
    "登录未完成",
    `${statusIcon("warn")}<h1>登录未完成</h1><p class="sub">${esc(message)}</p>` +
      `<a class="btn btn-primary" href="${esc(flowUrl("/", ctx))}">返回登录</a>`,
    status,
  );
}

function clearLoginState(response: Response, secure: boolean): Response {
  response.headers.append("Set-Cookie", clearSessionCookie(LOGIN_STATE_COOKIE, secure));
  return response;
}

async function contextFromLoginState(
  state: Awaited<ReturnType<typeof verifyLoginState>>,
  deps: LoginServiceDeps,
  env: NodeJS.ProcessEnv,
): Promise<LoginContext | { error: string; status: number }> {
  if (!state) return { error: "登录状态已失效，请重新开始。", status: 400 };
  return loadContext(
    new URLSearchParams({ app: state.appId, r: state.redirect, next: state.next }),
    deps,
    env,
  );
}

async function authRepository(deps: LoginServiceDeps): Promise<PhoneAuthRepository | null> {
  if (!deps.createAuthRepository) return null;
  const repository = (await deps.createAuthRepository()) as Partial<PhoneAuthRepository> | null;
  if (
    !repository ||
    typeof repository.phoneSendCode !== "function" ||
    typeof repository.phoneLogin !== "function"
  ) return null;
  return repository as PhoneAuthRepository;
}

async function bounceWithSso(
  ctx: LoginContext,
  user: { sub: string; email: string },
  secure: boolean,
  cookies: string[] = [],
): Promise<Response> {
  const sso = await mintSsoSession(user);
  return bounceWithCode(ctx, user, [
    ...cookies,
    serializeSessionCookie(SSO_COOKIE, sso.token, SSO_TTL_SECONDS, secure),
  ]);
}

function isOAuthProvider(value: string): value is OAuthProvider {
  return value === "google" || value === "wechat";
}

async function handlePhoneStart(
  form: URLSearchParams,
  req: Request,
  deps: LoginServiceDeps,
  env: NodeJS.ProcessEnv,
): Promise<Response> {
  const ctx = await loadContext(form, deps, env);
  if ("error" in ctx) return noticePage(ctx.error, ctx.status);
  if (!authMethodEnabled("phone", env)) return noticePage("手机号登录未启用。", 404);

  const phone = (form.get("phone") ?? "").trim();
  if (phone.length < 6) return phonePage(ctx, env, phone, "请填写有效的手机号码。", 400);

  const limiter = deps.rateLimited ?? isRateLimited;
  const { ip } = resolveClientIp((n) => req.headers.get(n) ?? undefined);
  if (limiter(`apps-login:phone:${ip ?? "unknown"}:${phone}`, PHONE_OTP_RATE_LIMIT)) {
    return phonePage(ctx, env, phone, "尝试过于频繁，请稍后再试。", 429);
  }

  try {
    const repository = await authRepository(deps);
    if (!repository) return phonePage(ctx, env, phone, "手机号登录尚未配置。", 503);
    // The desktop client uses the same non-empty captcha placeholder until the
    // partner captcha is wired. The repository remains the single validator.
    await repository.phoneSendCode({ phone, captchaVerify: "fc-app-login" });
    return phoneCodePage(ctx, phone, "", 200, form.get("resend") === "1" ? "新的验证码已发送。" : "");
  } catch (error) {
    const failure = authFailure(error);
    return phonePage(ctx, env, phone, failure.message, failure.status);
  }
}

async function phoneLoginResult(
  ctx: LoginContext,
  phone: string,
  code: string,
  deps: LoginServiceDeps,
  env: NodeJS.ProcessEnv,
  secure: boolean,
  userId?: string,
): Promise<Response> {
  try {
    const repository = await authRepository(deps);
    if (!repository) return phoneCodePage(ctx, phone, "手机号登录尚未配置。", 503);
    // An app whose tenant is unknown cannot narrow anything, and widening to
    // every org is the behaviour this change exists to remove. Refuse instead:
    // a null org_id is an operator's problem (see the gateway's `no_app_org`),
    // and it is the same one, said in the same place the visitor is standing.
    if (!ctx.app.orgId) {
      return phoneCodePage(ctx, phone, "该应用未关联组织，无法登录。", 503);
    }
    const result = (await repository.phoneLogin({
      phone,
      code,
      userId,
      tenantOrgId: ctx.app.orgId,
      // App-level, never derived from `next` — see appAdmitsAnyAudience.
      allowSignup: appAdmitsAnyAudience(
        ctx.app.authScope,
        ctx.app.authRules,
        ctx.app.authAudience,
      ),
    })) as any;
    if (result?.multiUser && Array.isArray(result.users)) {
      return phoneAccountPage(ctx, phone, code, result.users as PhoneLoginUser[]);
    }
    const user = userFromAuthBody(result?.session);
    if (!user) return phoneCodePage(ctx, phone, "登录服务暂时不可用，请稍后再试。", 503);
    return bounceWithSso(ctx, user, secure);
  } catch (error) {
    const failure = authFailure(error);
    return phoneCodePage(ctx, phone, failure.message, failure.status);
  }
}

async function handlePhoneVerify(
  form: URLSearchParams,
  deps: LoginServiceDeps,
  env: NodeJS.ProcessEnv,
  secure: boolean,
): Promise<Response> {
  const ctx = await loadContext(form, deps, env);
  if ("error" in ctx) return noticePage(ctx.error, ctx.status);
  if (!authMethodEnabled("phone", env)) return noticePage("手机号登录未启用。", 404);
  const phone = (form.get("phone") ?? "").trim();
  const code = (form.get("code") ?? "").trim();
  if (!phone || !/^\d{6}$/.test(code)) {
    return phoneCodePage(ctx, phone, "请输入 6 位验证码。", 400);
  }
  return phoneLoginResult(ctx, phone, code, deps, env, secure);
}

async function handlePhoneSelect(
  form: URLSearchParams,
  deps: LoginServiceDeps,
  env: NodeJS.ProcessEnv,
  secure: boolean,
): Promise<Response> {
  const ctx = await loadContext(form, deps, env);
  if ("error" in ctx) return noticePage(ctx.error, ctx.status);
  if (!authMethodEnabled("phone", env)) return noticePage("手机号登录未启用。", 404);
  const phone = (form.get("phone") ?? "").trim();
  const code = (form.get("code") ?? "").trim();
  const userId = (form.get("userId") ?? "").trim();
  if (!phone || !/^\d{6}$/.test(code) || !userId) {
    return phoneCodePage(ctx, phone, "请选择一个账号。", 400);
  }
  // Keep the same repository operation as the first verification. The OTP is
  // not consumed while the picker is displayed, so the selected user can be
  // passed back to the same operation.
  return phoneLoginResult(ctx, phone, code, deps, env, secure, userId);
}

async function handleOAuthStart(
  provider: OAuthProvider,
  url: URL,
  req: Request,
  deps: LoginServiceDeps,
  env: NodeJS.ProcessEnv,
  secure: boolean,
): Promise<Response> {
  const ctx = await loadContext(url.searchParams, deps, env);
  if ("error" in ctx) return noticePage(ctx.error, ctx.status);
  if (!authMethodEnabled(provider, env)) return noticePage("该登录方式未启用。", 404);
  const base = publicGotrueBase(env);
  if (!base) return noticePage("登录服务尚未配置。", 503);

  const verifier = pkceVerifier();
  const state = randomBytes(24).toString("base64url");
  const loginState = await mintLoginState({
    appId: ctx.app.id,
    redirect: ctx.origin,
    next: ctx.next,
    provider,
    state,
    codeVerifier: verifier,
  });
  const callback = `${loginOrigin(req, secure, env)}${OAUTH_CALLBACK_PATH}`;
  const target = new URL(`${base}/auth/v1/authorize`);
  target.searchParams.set("provider", provider);
  target.searchParams.set("redirect_to", callback);
  target.searchParams.set("code_challenge", pkceChallenge(verifier));
  target.searchParams.set("code_challenge_method", "s256");
  target.searchParams.set("state", state);
  return redirect(
    target.toString(),
    [serializeSessionCookie(LOGIN_STATE_COOKIE, loginState.token, LOGIN_STATE_TTL_SECONDS, secure)],
  );
}

async function handleOAuthCallback(
  url: URL,
  req: Request,
  deps: LoginServiceDeps,
  env: NodeJS.ProcessEnv,
  secure: boolean,
): Promise<Response> {
  const token = readCookie(req.headers.get("cookie"), LOGIN_STATE_COOKIE) ?? "";
  const state = await verifyLoginState(token);
  const clear = () => clearSessionCookie(LOGIN_STATE_COOKIE, secure);
  if (!state || url.searchParams.get("state") !== state.state || !isOAuthProvider(state.provider)) {
    return clearLoginState(noticePage("登录状态已失效，请重新开始。", 400), secure);
  }
  const ctx = await contextFromLoginState(state, deps, env);
  if ("error" in ctx) return clearLoginState(noticePage(ctx.error, ctx.status), secure);
  if (!authMethodEnabled(state.provider, env)) {
    return clearLoginState(retryPage(ctx, "该登录方式已被关闭，请重新选择登录方式。", 400), secure);
  }
  if (url.searchParams.get("error") || !url.searchParams.get("code")) {
    return clearLoginState(retryPage(ctx, "登录未完成，请重新选择登录方式。", 400), secure);
  }

  const result = await callGotrue(
    "/auth/v1/token?grant_type=pkce",
    { auth_code: url.searchParams.get("code"), code_verifier: state.codeVerifier },
    deps,
    env,
  );
  if (result.kind !== "ok") {
    return clearLoginState(
      retryPage(ctx, result.kind === "unavailable" ? result.message : "登录未完成，请重试。", result.kind === "unavailable" ? 503 : 400),
      secure,
    );
  }
  const user = userFromAuthBody(result.body);
  if (!user) return clearLoginState(retryPage(ctx, "登录服务没有返回有效账号。", 503), secure);
  return bounceWithSso(ctx, user, secure, [clear()]);
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
        ? `${statusIcon("ok")}<h1>已登录</h1><p class="sub">当前账号 <strong>${esc(session.email)}</strong>。` +
            `请从应用的地址进入。</p>` +
            `<form method="post" action="/logout"><button class="btn btn-outline" type="submit">退出登录</button></form>`
        : `${statusIcon("lock")}<h1>从应用进入</h1>` +
            `<p class="sub">请从你要访问的应用地址进入，这里会引导你完成登录。</p>`,
    );
  }

  const ctx = await loadContext(url.searchParams, deps, env);
  if ("error" in ctx) return noticePage(ctx.error, ctx.status);

  // The SSO shortcut. This branch is the whole point of a central login
  // service: the second app a visitor opens costs them two redirects and no
  // typing.
  const session = await verifySsoSession(readCookie(req.headers.get("cookie"), SSO_COOKIE) ?? "");
  if (session) return bounceWithCode(ctx, session);

  const method = url.searchParams.get("method");
  if (method === "phone" && authMethodEnabled("phone", env)) return phonePage(ctx, env);
  if (method === "password" && authMethodEnabled("password", env)) return passwordPage(ctx, env);
  return emailPage(ctx, env);
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
    return emailPage(ctx, env, email, "请填写一个有效的邮箱地址。", 400);
  }

  // Per IP AND per address: keying on one alone lets an attacker either mail
  // one victim from many hosts, or many victims from one.
  const limiter = deps.rateLimited ?? isRateLimited;
  const { ip } = resolveClientIp((n) => req.headers.get(n) ?? undefined);
  if (limiter(`apps-login:otp:${ip ?? "unknown"}:${email}`, OTP_RATE_LIMIT)) {
    return emailPage(ctx, env, email, "尝试过于频繁，请等一分钟再试。", 429);
  }

  const result = await callGotrue("/auth/v1/otp", { email, create_user: true }, deps, env);
  if (result.kind !== "ok") {
    const down = result.kind === "unavailable";
    return emailPage(
      ctx,
      env,
      email,
      down ? result.message : "这个邮箱地址无法接收验证码。",
      down ? 503 : 400,
    );
  }
  return codePage(ctx, email, "", 200, form.get("resend") === "1" ? "新的验证码已发送。" : "");
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
  if (!looksLikeEmail(email)) return emailPage(ctx, env, email, "请重新输入邮箱地址。", 400);
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

  const user = userFromAuthBody(result.body, email);
  if (!user) {
    // GoTrue answered 200 without a user. Treat as unavailable rather than
    // minting a session with no subject to bind it to.
    return codePage(ctx, email, "登录服务暂时不可用，请稍后再试。", 503);
  }

  return bounceWithSso(ctx, user, secure);
}

/**
 * Email + password, offered only where `features.auth.password` is on.
 *
 * GoTrue is asked directly, the same way the code flow above is. A wrong
 * password and an unknown address get one message: telling them apart would
 * let anyone test which addresses have accounts. The password is never written
 * back into the page.
 */
async function handlePassword(
  form: URLSearchParams,
  req: Request,
  deps: LoginServiceDeps,
  env: NodeJS.ProcessEnv,
  secure: boolean,
): Promise<Response> {
  const ctx = await loadContext(form, deps, env);
  if ("error" in ctx) return noticePage(ctx.error, ctx.status);
  if (!authMethodEnabled("password", env)) return noticePage("密码登录未启用。", 404);

  const email = (form.get("email") ?? "").trim().toLowerCase();
  const password = form.get("password") ?? "";
  if (!looksLikeEmail(email)) {
    return passwordPage(ctx, env, email, "请填写一个有效的邮箱地址。", 400);
  }
  if (!password) return passwordPage(ctx, env, email, "请输入密码。", 400);

  const limiter = deps.rateLimited ?? isRateLimited;
  const { ip } = resolveClientIp((n) => req.headers.get(n) ?? undefined);
  if (limiter(`apps-login:password:${ip ?? "unknown"}:${email}`, PASSWORD_RATE_LIMIT)) {
    return passwordPage(ctx, env, email, "尝试过于频繁，请等一分钟再试。", 429);
  }

  const result = await callGotrue(
    "/auth/v1/token?grant_type=password",
    { email, password },
    deps,
    env,
  );
  if (result.kind !== "ok") {
    const down = result.kind === "unavailable";
    return passwordPage(
      ctx,
      env,
      email,
      down ? result.message : "邮箱或密码不正确。",
      down ? 503 : 400,
    );
  }

  const user = userFromAuthBody(result.body, email);
  if (!user) return passwordPage(ctx, env, email, "登录服务暂时不可用，请稍后再试。", 503);
  return bounceWithSso(ctx, user, secure);
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

  if (req.method === "GET" && (path === "/oauth/google" || path === "/oauth/wechat")) {
    return handleOAuthStart(path.slice("/oauth/".length) as OAuthProvider, url, req, deps, env, secure);
  }
  if (req.method === "GET" && path === OAUTH_CALLBACK_PATH) {
    return handleOAuthCallback(url, req, deps, env, secure);
  }

  if (
    req.method === "POST" &&
    ["/otp", "/verify", "/password", "/logout", "/phone", "/phone/verify", "/phone/select"].includes(path)
  ) {
    if (path === "/logout") return handleLogout(secure);
    // Deliberately not req.formData(): these forms are urlencoded, and
    // URLSearchParams cannot be talked into multipart parsing by a caller.
    const form = new URLSearchParams(await req.text());
    if (path === "/otp") return handleOtp(form, req, deps, env);
    if (path === "/verify") return handleVerify(form, deps, env, secure);
    if (path === "/password") return handlePassword(form, req, deps, env, secure);
    if (path === "/phone") return handlePhoneStart(form, req, deps, env);
    if (path === "/phone/verify") return handlePhoneVerify(form, deps, env, secure);
    return handlePhoneSelect(form, deps, env, secure);
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
      `${statusIcon("ok")}<h1>已退出</h1><p class="sub">你已从所有应用退出登录。</p>`,
    );
    res.headers.append("Set-Cookie", clearSessionCookie(SSO_COOKIE, secure));
    return res;
  }

  // A GET to the other POST-only paths is a stale bookmark or a back button,
  // not an error worth a status code — send them to the start of the flow.
  if (
    req.method === "GET" &&
    (path === "/otp" || path === "/verify" || path === "/password" || path.startsWith("/phone"))
  ) {
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
