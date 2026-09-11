import { createHash, randomBytes } from "node:crypto";

import { appOrigins } from "./apps-public-host.js";
import { esc, page, redirect, safeNext } from "./apps-auth-page.js";
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
import { isRateLimited, resolveClientIp } from "./rate-limit.js";
import { resolveFeatures } from "./routes/config.js";

/**
 * The central login service for deployed apps
 * (`docs/specs/2026-09-08-apps-login-and-custom-domain-design.md` §4.3-§4.4).
 *
 * It answers on one hostname — `LOGIN_DOMAIN` — and owns the entire login
 * experience: the page, the email/phone round trips, configured OAuth/Web SSO,
 * and the SSO cookie. Apps never see any of it. What crosses back to an app's
 * own hostname is a single one-shot code, because a cookie set here cannot be
 * read on `app.example.com`, and once custom domains exist that is the common
 * case rather than the exception.
 *
 * Holding a valid SSO cookie is what makes the second app skip the login page:
 * `GET /` mints a code immediately and bounces, so the visitor sees two
 * redirects and no form.
 *
 * Email and phone stay plain `<form>` POSTs. Web SSO has one tiny inline bridge
 * script because only the browser can read a provider session in a URL
 * fragment; it has no dependency on the app's script bundle.
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
const OAUTH_CALLBACK_PATH = "/oauth/callback";
const WEB_SSO_CALLBACK_PATH = "/sso/callback";

type OAuthProvider = "google" | "wechat";
type LoginMethod = "phone" | "google" | "wechat" | "webSSO";

type PhoneLoginUser = {
  id: string;
  org_id?: string | null;
  org_name?: string | null;
  nickname?: string | null;
  email?: string | null;
};

type PhoneAuthRepository = {
  phoneSendCode: (args: { phone: string; captchaVerify?: string }) => Promise<unknown>;
  phoneLogin: (args: { phone: string; code: string; userId?: string }) => Promise<unknown>;
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

function authMethodEnabled(method: LoginMethod, env: NodeJS.ProcessEnv): boolean {
  const auth = resolveFeatures(env).auth;
  return auth?.[method] === true;
}

function webSsoUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = env.WEBSSO_LOGIN_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
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

/** Validate a refresh/access token harvested by the browser SSO bridge. */
async function callGotrueUser(
  accessToken: string,
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
    res = await fetchImpl(`${base}/auth/v1/user`, {
      method: "GET",
      headers: { apikey: key, Authorization: `Bearer ${accessToken}` },
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
  if (res.ok) return { kind: "ok", body: { user: parsed }, message: "" };
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

function methodLinks(
  ctx: LoginContext,
  env: NodeJS.ProcessEnv,
  current?: LoginMethod,
): string {
  const links: string[] = [];
  if (current !== "phone" && authMethodEnabled("phone", env)) {
    links.push(`<a href="${esc(flowUrl("/", ctx, { method: "phone" }))}">手机号登录</a>`);
  }
  if (authMethodEnabled("google", env)) {
    links.push(`<a href="${esc(flowUrl("/oauth/google", ctx))}">Google 登录</a>`);
  }
  // Keep this in lock-step with the Tauri auth config. WeChat is not enabled
  // by the shipped profiles, but a deployment that turns it on gets the same
  // provider here as well.
  if (authMethodEnabled("wechat", env)) {
    links.push(`<a href="${esc(flowUrl("/oauth/wechat", ctx))}">微信登录</a>`);
  }
  if (authMethodEnabled("webSSO", env) && webSsoUrl(env)) {
    links.push(`<a href="${esc(flowUrl("/sso", ctx))}">快捷登录</a>`);
  }
  return links.length ? `<nav class="methods">${links.join("")}</nav>` : "";
}

function emailPage(
  ctx: LoginContext,
  email = "",
  error = "",
  status = 200,
  env: NodeJS.ProcessEnv = process.env,
): Response {
  return page(
    "登录",
    `<h1>登录</h1><p class="sub">继续访问需要先验证你的邮箱。</p>` +
      errorBlock(error) +
      `<form method="post" action="/otp">${carried(ctx)}` +
      `<label for="email">邮箱</label>` +
      `<input id="email" name="email" type="email" inputmode="email" autocomplete="email" ` +
      `autofocus required value="${esc(email)}">` +
      `<button type="submit">发送验证码</button></form>` +
      methodLinks(ctx, env),
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

function phonePage(
  ctx: LoginContext,
  phone = "",
  error = "",
  status = 200,
  env: NodeJS.ProcessEnv = process.env,
): Response {
  return page(
    "手机号登录",
    `<h1>手机号登录</h1><p class="sub">我们会向你的手机发送 6 位验证码。</p>` +
      errorBlock(error) +
      `<form method="post" action="/phone">${carried(ctx)}` +
      `<label for="phone">手机号</label>` +
      `<input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" ` +
      `autofocus required value="${esc(phone)}" placeholder="+8613800138000">` +
      `<button type="submit">发送验证码</button></form>` +
      `<p class="foot"><a href="${esc(flowUrl("/", ctx))}">使用邮箱登录</a></p>` +
      methodLinks(ctx, env, "phone"),
    status,
  );
}

function phoneCodePage(ctx: LoginContext, phone: string, error = "", status = 200): Response {
  return page(
    "输入验证码",
    `<h1>输入验证码</h1><p class="sub">验证码已发送到 ${esc(phone)}。</p>` +
      errorBlock(error) +
      `<form method="post" action="/phone/verify">${carried(ctx)}` +
      `<input type="hidden" name="phone" value="${esc(phone)}">` +
      `<label for="code">验证码</label>` +
      `<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" ` +
      `class="code-input" autofocus required maxlength="6" pattern="[0-9]{6}">` +
      `<button type="submit">登录</button></form>` +
      `<p class="foot"><a href="${esc(flowUrl("/", ctx, { method: "phone" }))}">换一个手机号</a></p>`,
    status,
  );
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
      const detail = user.org_name?.trim() || user.email?.trim() || "";
      return (
        `<button type="submit" name="userId" value="${esc(user.id)}">` +
        `<span>${esc(label)}</span>${detail ? `<small>${esc(detail)}</small>` : ""}</button>`
      );
    })
    .join("");
  return page(
    "选择账号",
    `<h1>选择账号</h1><p class="sub">手机号 ${esc(phone)} 关联了多个账号，请选择要登录的账号。</p>` +
      errorBlock(error) +
      `<form method="post" action="/phone/select">${carried(ctx)}` +
      `<input type="hidden" name="phone" value="${esc(phone)}">` +
      `<input type="hidden" name="code" value="${esc(code)}">` +
      `<div class="account-choices">${choices}</div></form>` +
      `<p class="foot"><a href="${esc(flowUrl("/", ctx, { method: "phone" }))}">使用其他手机号</a></p>`,
    status,
  );
}

function noticePage(message: string, status: number): Response {
  return page("登录", `<h1>无法继续</h1><p class="sub">${esc(message)}</p>`, status);
}

function retryPage(ctx: LoginContext, message: string, status: number): Response {
  return page(
    "登录",
    `<h1>无法继续</h1><p class="sub">${esc(message)}</p>` +
      `<a class="btn" href="${esc(flowUrl("/", ctx))}">返回登录</a>`,
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
  if (phone.length < 6) return phonePage(ctx, phone, "请填写有效的手机号码。", 400, env);

  const limiter = deps.rateLimited ?? isRateLimited;
  const { ip } = resolveClientIp((n) => req.headers.get(n) ?? undefined);
  if (limiter(`apps-login:phone:${ip ?? "unknown"}:${phone}`, PHONE_OTP_RATE_LIMIT)) {
    return phonePage(ctx, phone, "尝试过于频繁，请稍后再试。", 429, env);
  }

  try {
    const repository = await authRepository(deps);
    if (!repository) return phonePage(ctx, phone, "手机号登录尚未配置。", 503, env);
    // The desktop client uses the same non-empty captcha placeholder until the
    // partner captcha is wired. The repository remains the single validator.
    await repository.phoneSendCode({ phone, captchaVerify: "fc-app-login" });
    return phoneCodePage(ctx, phone);
  } catch (error) {
    const failure = authFailure(error);
    return phonePage(ctx, phone, failure.message, failure.status, env);
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
    const result = (await repository.phoneLogin({ phone, code, userId })) as any;
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

function webSsoBridgePage(): Response {
  return page(
    "快捷登录",
    `<h1>快捷登录</h1><p class="sub">正在读取登录结果，请稍候……</p>` +
      `<p id="message" class="foot">如果页面没有继续，请关闭此页后重试。</p>` +
      `<script>` +
      `(async()=>{` +
      `const p=new URLSearchParams(location.hash.slice(1));` +
      `history.replaceState(null,"",location.pathname+location.search);` +
      `const f=document.createElement("form");f.method="POST";f.action="/sso/exchange";` +
      `for(const k of ["access_token","refresh_token"]){const v=p.get(k);if(v){const i=document.createElement("input");i.type="hidden";i.name=k;i.value=v;f.append(i)}}` +
      `if(!f.elements.length){document.getElementById("message").textContent="没有读取到登录结果，请重试。";return}` +
      `document.body.append(f);f.submit();` +
      `})();</script>`,
  );
}

async function handleWebSsoStart(
  url: URL,
  req: Request,
  deps: LoginServiceDeps,
  env: NodeJS.ProcessEnv,
  secure: boolean,
): Promise<Response> {
  const ctx = await loadContext(url.searchParams, deps, env);
  if ("error" in ctx) return noticePage(ctx.error, ctx.status);
  const targetRaw = webSsoUrl(env);
  if (!authMethodEnabled("webSSO", env) || !targetRaw) {
    return noticePage("快捷登录未启用。", 404);
  }
  const verifier = pkceVerifier();
  const state = randomBytes(24).toString("base64url");
  const loginState = await mintLoginState({
    appId: ctx.app.id,
    redirect: ctx.origin,
    next: ctx.next,
    provider: "webSSO",
    state,
    codeVerifier: verifier,
  });
  const callback = `${loginOrigin(req, secure, env)}${WEB_SSO_CALLBACK_PATH}`;
  const target = new URL(targetRaw);
  // The configured admin login page is the same page Tauri opens. These
  // standard names let a web-capable admin login return either a PKCE code or
  // the Supabase session fragment to this bridge. Existing admin pages may
  // ignore the extra query parameters without affecting Tauri's flow.
  target.searchParams.set("redirect_to", callback);
  target.searchParams.set("return_to", callback);
  target.searchParams.set("state", state);
  target.searchParams.set("code_challenge", pkceChallenge(verifier));
  target.searchParams.set("code_challenge_method", "s256");
  return redirect(
    target.toString(),
    [serializeSessionCookie(LOGIN_STATE_COOKIE, loginState.token, LOGIN_STATE_TTL_SECONDS, secure)],
  );
}

async function finishWebSso(
  state: Awaited<ReturnType<typeof verifyLoginState>>,
  request: { accessToken?: string; refreshToken?: string },
  deps: LoginServiceDeps,
  env: NodeJS.ProcessEnv,
  secure: boolean,
): Promise<Response> {
  const ctx = await contextFromLoginState(state, deps, env);
  if ("error" in ctx) return clearLoginState(noticePage(ctx.error, ctx.status), secure);
  if (!authMethodEnabled("webSSO", env)) {
    return clearLoginState(retryPage(ctx, "该登录方式已被关闭，请重新选择登录方式。", 400), secure);
  }
  let result: GotrueResult;
  if (request.refreshToken) {
    result = await callGotrue(
      "/auth/v1/token?grant_type=refresh_token",
      { refresh_token: request.refreshToken },
      deps,
      env,
    );
  } else if (request.accessToken) {
    result = await callGotrueUser(request.accessToken, deps, env);
  } else {
    return clearLoginState(retryPage(ctx, "没有读取到登录结果，请重试。", 400), secure);
  }
  if (result.kind !== "ok") {
    return clearLoginState(
      retryPage(ctx, result.kind === "unavailable" ? result.message : "登录未完成，请重试。", result.kind === "unavailable" ? 503 : 400),
      secure,
    );
  }
  const user = userFromAuthBody(result.body);
  if (!user) return clearLoginState(retryPage(ctx, "登录服务没有返回有效账号。", 503), secure);
  return bounceWithSso(ctx, user, secure, [clearSessionCookie(LOGIN_STATE_COOKIE, secure)]);
}

async function handleWebSsoCallback(
  url: URL,
  req: Request,
  deps: LoginServiceDeps,
  env: NodeJS.ProcessEnv,
  secure: boolean,
): Promise<Response> {
  const state = await verifyLoginState(readCookie(req.headers.get("cookie"), LOGIN_STATE_COOKIE) ?? "");
  if (!state || state.provider !== "webSSO") {
    return clearLoginState(noticePage("登录状态已失效，请重新开始。", 400), secure);
  }
  const queryState = url.searchParams.get("state");
  if (queryState && queryState !== state.state) {
    return clearLoginState(noticePage("登录状态已失效，请重新开始。", 400), secure);
  }
  const ctx = await contextFromLoginState(state, deps, env);
  if ("error" in ctx) return clearLoginState(noticePage(ctx.error, ctx.status), secure);
  if (!authMethodEnabled("webSSO", env)) {
    return clearLoginState(retryPage(ctx, "该登录方式已被关闭，请重新选择登录方式。", 400), secure);
  }
  if (url.searchParams.get("error")) {
    return clearLoginState(retryPage(ctx, "登录未完成，请重新选择登录方式。", 400), secure);
  }
  const code = url.searchParams.get("code");
  if (code) {
    if (queryState !== state.state) {
      return clearLoginState(noticePage("登录状态已失效，请重新开始。", 400), secure);
    }
    const result = await callGotrue(
      "/auth/v1/token?grant_type=pkce",
      { auth_code: code, code_verifier: state.codeVerifier },
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
    if (!user) return clearLoginState(noticePage("登录服务没有返回有效账号。", 503), secure);
    return bounceWithSso(ctx, user, secure, [clearSessionCookie(LOGIN_STATE_COOKIE, secure)]);
  }
  // Supabase implicit-flow tokens arrive in the URL fragment, which the
  // browser-only bridge above reads without sending them to FC access logs.
  // Never accept access or refresh tokens in the query string.
  return webSsoBridgePage();
}

async function handleWebSsoExchange(
  req: Request,
  deps: LoginServiceDeps,
  env: NodeJS.ProcessEnv,
  secure: boolean,
): Promise<Response> {
  const state = await verifyLoginState(readCookie(req.headers.get("cookie"), LOGIN_STATE_COOKIE) ?? "");
  if (!state || state.provider !== "webSSO") {
    return clearLoginState(noticePage("登录状态已失效，请重新开始。", 400), secure);
  }
  const body = new URLSearchParams(await req.text());
  return finishWebSso(
    state,
    { accessToken: body.get("access_token") ?? undefined, refreshToken: body.get("refresh_token") ?? undefined },
    deps,
    env,
    secure,
  );
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

  if (url.searchParams.get("method") === "phone" && authMethodEnabled("phone", env)) {
    return phonePage(ctx, "", "", 200, env);
  }
  return emailPage(ctx, "", "", 200, env);
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
    return emailPage(ctx, email, "请填写一个有效的邮箱地址。", 400, env);
  }

  // Per IP AND per address: keying on one alone lets an attacker either mail
  // one victim from many hosts, or many victims from one.
  const limiter = deps.rateLimited ?? isRateLimited;
  const { ip } = resolveClientIp((n) => req.headers.get(n) ?? undefined);
  if (limiter(`apps-login:otp:${ip ?? "unknown"}:${email}`, OTP_RATE_LIMIT)) {
    return emailPage(ctx, email, "尝试过于频繁，请等一分钟再试。", 429, env);
  }

  const result = await callGotrue("/auth/v1/otp", { email, create_user: true }, deps, env);
  if (result.kind !== "ok") {
    const down = result.kind === "unavailable";
    return emailPage(
      ctx,
      email,
      down ? result.message : "这个邮箱地址无法接收验证码。",
      down ? 503 : 400,
      env,
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
  if (!looksLikeEmail(email)) return emailPage(ctx, email, "请重新输入邮箱地址。", 400, env);
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
  if (req.method === "GET" && path === "/oauth/callback") {
    return handleOAuthCallback(url, req, deps, env, secure);
  }
  if (req.method === "GET" && path === "/sso") {
    return handleWebSsoStart(url, req, deps, env, secure);
  }
  if (req.method === "GET" && path === WEB_SSO_CALLBACK_PATH) {
    return handleWebSsoCallback(url, req, deps, env, secure);
  }

  if (
    req.method === "POST" &&
    ["/otp", "/verify", "/logout", "/phone", "/phone/verify", "/phone/select", "/sso/exchange"].includes(path)
  ) {
    if (path === "/logout") return handleLogout(secure);
    if (path === "/sso/exchange") return handleWebSsoExchange(req, deps, env, secure);
    // Deliberately not req.formData(): these forms are urlencoded, and
    // URLSearchParams cannot be talked into multipart parsing by a caller.
    const form = new URLSearchParams(await req.text());
    if (path === "/otp") return handleOtp(form, req, deps, env);
    if (path === "/verify") return handleVerify(form, deps, env, secure);
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
      `<h1>已退出</h1><p class="sub">你已从所有应用退出登录。</p>`,
    );
    res.headers.append("Set-Cookie", clearSessionCookie(SSO_COOKIE, secure));
    return res;
  }

  // A GET to the other POST-only paths is a stale bookmark or a back button,
  // not an error worth a status code — send them to the start of the flow.
  if (req.method === "GET" && (path === "/otp" || path === "/verify" || path.startsWith("/phone"))) {
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
