import { createHash } from "node:crypto";
import { ApiError } from "../http-utils.js";
import { createServiceRoleClient } from "../supabase.js";
import { verifyTrustedExternalJwt } from "../trusted-external-jwt.js";
import {
  gitTokenEpochOf,
  readGitTokenSecret,
  signGitToken,
  verifyGitToken,
  GIT_TOKEN_TTL_SECONDS,
} from "./git-token.js";
import { giteaUserName } from "./gitea/client.js";
import { giteaAccountAuthEnabled } from "./gitea/sync-runner.js";
import { readAppGitAccess } from "./app-git-access.js";
import { parseGitHttpsCredentialInput } from "./imported-http.js";

/**
 * Per-account git over HTTPS (docs/specs/2026-11-16-app-platform-identity-design.md §4, §6).
 *
 *   POST /v1/git/token          a person's machine gets its git-only token
 *   POST /v1/git/token/revoke   sign-out: every git token of the account dies
 *   GET  /v1/git/authz          Caddy forward_auth: who is this git request?
 *   GET  /v1/git/access         the credential helper: why was I refused?
 *   GET  /v1/git/host           a daemon: which host is this cloud's git host?
 *
 * The first four authenticate themselves (route `auth: "none"`): the credential is
 * either a git token (`aud=teamclu-git`, see git-token.ts) or a TeamClu login
 * token — an agent's, handed to it by its daemon — and the generic bearer
 * middleware only knows the latter.
 *
 * `authz` decides only WHO. Whether that account may read or push the repo is
 * Gitea's call, from the collaborators and teams FC mirrors onto it.
 */

export interface GitRouteDeps {
  secret(): string | null;
  /** Service-role Supabase client (`.auth.admin`, `.auth.getUser`, `.from`). */
  admin(): any;
  now(): number;
  /** Public git host the desktop configures its credential helper for. */
  gitHost(): string | null;
  /** `https` or `http` — the scheme of that host, so the helper matches it. */
  gitScheme?(): "https" | "http";
  /** `GITEA_ACCOUNT_AUTH=on`. Off: no git tokens, clients stay on SSH. */
  accountAuth?(): boolean;
  trustedExternalJwtSecret(): string | undefined;
}

function defaultDeps(): GitRouteDeps {
  return {
    secret: () => readGitTokenSecret(),
    admin: () => createServiceRoleClient(),
    now: () => Date.now(),
    gitHost: () => readGitPublicHost(),
    gitScheme: () => readGitPublicScheme(),
    accountAuth: () => giteaAccountAuthEnabled(),
    trustedExternalJwtSecret: () => process.env.TRUSTED_EXTERNAL_JWT_SECRET || undefined,
  };
}

/** Host of `GITEA_PUBLIC_URL` (the HTTPS base clients clone from), or null. */
export function readGitPublicHost(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.GITEA_PUBLIC_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).host || null;
  } catch {
    return null;
  }
}

/**
 * Scheme of `GITEA_PUBLIC_URL`. Anything but an explicit `http:` is `https`:
 * the desktop keys its credential helper on `<scheme>://<host>`, and git only
 * consults a helper whose scheme matches the URL it is fetching.
 */
export function readGitPublicScheme(env: NodeJS.ProcessEnv = process.env): "https" | "http" {
  const raw = env.GITEA_PUBLIC_URL?.trim();
  if (!raw) return "https";
  try {
    return new URL(raw).protocol === "http:" ? "http" : "https";
  } catch {
    return "https";
  }
}

/** The secret a git client presents: Basic password (git) or a bearer (everything else). */
export function credentialFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  const basic = /^Basic\s+(.+)$/i.exec(header.trim());
  if (basic) {
    try {
      const decoded = Buffer.from(basic[1], "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      const password = colon >= 0 ? decoded.slice(colon + 1) : "";
      return password.trim() || null;
    } catch {
      return null;
    }
  }
  const bearer = /^Bearer\s+(.+)$/i.exec(header.trim());
  return bearer ? bearer[1].trim() || null : null;
}

type Caller = { userId: string; via: "git_token" | "login_token" };

/**
 * Small cache so one `git push` (three HTTP round trips, each forward_auth'd)
 * costs one verification. Keyed by a hash so no token sits in memory as-is.
 * 60 seconds bounds how long a revoked token or a disabled account outlives
 * its revocation.
 *
 * Bounded, because these routes take any password from anyone: every distinct
 * junk credential is a new key, and an entry nobody asks for again is never
 * read, so expiry-on-read alone never frees it.
 */
const CACHE_TTL_MS = 60_000;
export const GIT_CALLER_CACHE_MAX = 5_000;
const callerCache = new Map<string, { caller: Caller | null; until: number }>();

export function resetGitCallerCache() {
  callerCache.clear();
}

export function gitCallerCacheSize(): number {
  return callerCache.size;
}

function rememberCaller(key: string, caller: Caller | null, now: number) {
  if (callerCache.size >= GIT_CALLER_CACHE_MAX && !callerCache.has(key)) {
    for (const [k, entry] of callerCache) if (entry.until <= now) callerCache.delete(k);
    // Still full of live entries: drop the oldest (a Map iterates in insertion order).
    for (const k of callerCache.keys()) {
      if (callerCache.size < GIT_CALLER_CACHE_MAX) break;
      callerCache.delete(k);
    }
  }
  callerCache.set(key, { caller, until: now + CACHE_TTL_MS });
}

/**
 * GoTrue could not answer, as opposed to answering "no". Not worth remembering:
 * cached, one restart of GoTrue would refuse a valid token for a full minute.
 */
function isTransientAuthError(error: any): boolean {
  if (!error) return false;
  const status = Number(error.status);
  return error.name === "AuthRetryableFetchError" || status === 0 || status >= 500;
}

function isBanned(user: any, now: number): boolean {
  const until = user?.banned_until ? Date.parse(user.banned_until) : NaN;
  return Number.isFinite(until) && until > now;
}

/** Who presented `token`, or null. Never throws for a bad token. */
export async function resolveGitCaller(token: string, deps: GitRouteDeps): Promise<Caller | null> {
  const now = deps.now();
  const cacheKey = createHash("sha256").update(token).digest("hex");
  const cached = callerCache.get(cacheKey);
  if (cached && cached.until > now) return cached.caller;

  let caller: Caller | null = null;
  let transient = false;
  const admin = deps.admin();
  const secret = deps.secret();
  const claims = secret ? await verifyGitToken(token, secret, now) : null;
  if (claims) {
    // A git token is only as good as the account behind it right now: gone,
    // banned, or signed out since (epoch moved on) all mean no.
    const { data, error } = await admin.auth.admin.getUserById(claims.userId);
    const user = data?.user;
    transient = isTransientAuthError(error);
    if (!error && user && !isBanned(user, now) && gitTokenEpochOf(user) === claims.epoch) {
      caller = { userId: user.id, via: "git_token" };
    }
  } else {
    // An agent's own TeamClu login token, handed to it by its daemon.
    const { data, error } = await admin.auth.getUser(token);
    if (!error && data?.user?.id && !isBanned(data.user, now)) {
      caller = { userId: data.user.id, via: "login_token" };
    } else {
      transient = isTransientAuthError(error);
      const trusted = deps.trustedExternalJwtSecret();
      if (trusted) {
        try {
          const user = await verifyTrustedExternalJwt(token, trusted);
          caller = { userId: user.id, via: "login_token" };
        } catch {
          // Not that either.
        }
      }
    }
  }
  if (caller || !transient) rememberCaller(cacheKey, caller, now);
  return caller;
}

/** The person behind a TeamClu login bearer (desktop calls). */
async function requireLoginUser(ctx: any, deps: GitRouteDeps): Promise<any> {
  const header = ctx.getHeader("authorization");
  const bearer = /^Bearer\s+(.+)$/i.exec(header ?? "")?.[1]?.trim();
  if (!bearer) throw new ApiError(401, "unauthorized", "a TeamClu session is required");
  const admin = deps.admin();
  const { data, error } = await admin.auth.getUser(bearer);
  if (error || !data?.user?.id) throw new ApiError(401, "unauthorized", "invalid or expired session");
  if (isBanned(data.user, deps.now())) throw new ApiError(403, "forbidden", "account disabled");
  return data.user;
}

/** At most this many tokens per account per hour; a desktop needs one a month. */
const MINT_LIMIT = 10;
const mintLog = new Map<string, number[]>();

export function resetGitMintLimiter() {
  mintLog.clear();
}

const APP_REPO = /^tc-app-([0-9a-f-]{36})(?:\.git)?$/i;

export function registerGit(router, deps: GitRouteDeps = defaultDeps()) {
  router.post("/v1/git/token", { auth: "none" }, async (ctx) => {
    // A token is only useful while per-account git is on; minting one with the
    // flag off would still make the desktop install a global git helper.
    if (deps.accountAuth && !deps.accountAuth()) {
      throw new ApiError(503, "git_token_unavailable", "per-account git is not enabled on this deployment");
    }
    const secret = deps.secret();
    if (!secret) throw new ApiError(503, "git_token_unavailable", "GIT_TOKEN_SECRET is not configured");
    const user = await requireLoginUser(ctx, deps);
    const now = deps.now();
    const recent = (mintLog.get(user.id) ?? []).filter((t) => t > now - 3_600_000);
    if (recent.length >= MINT_LIMIT) throw new ApiError(429, "rate_limited", "too many git tokens minted this hour");
    recent.push(now);
    mintLog.set(user.id, recent);

    // Read the epoch fresh: the bearer's own claims may predate a revoke.
    const { data } = await deps.admin().auth.admin.getUserById(user.id);
    const epoch = gitTokenEpochOf(data?.user ?? user);
    const { token, expiresAt } = await signGitToken({ userId: user.id, epoch }, secret, now);
    return {
      body: {
        token,
        expiresAt,
        ttlSeconds: GIT_TOKEN_TTL_SECONDS,
        userId: user.id,
        userName: giteaUserName(user.id),
        gitHost: deps.gitHost(),
        gitScheme: deps.gitScheme?.() ?? "https",
      },
    };
  });

  router.post("/v1/git/token/revoke", { auth: "none" }, async (ctx) => {
    const user = await requireLoginUser(ctx, deps);
    const admin = deps.admin();
    const { data } = await admin.auth.admin.getUserById(user.id);
    const next = gitTokenEpochOf(data?.user ?? user) + 1;
    // GoTrue merges app_metadata key by key, so only this key changes.
    const { error } = await admin.auth.admin.updateUserById(user.id, { app_metadata: { git_token_epoch: next } });
    if (error) throw new ApiError(502, "upstream_unavailable", `could not revoke git tokens: ${error.message}`);
    resetGitCallerCache();
    return { body: { revoked: true, epoch: next } };
  });

  // Public on purpose: it is the host anyone sees in a clone address. A daemon
  // asks before it trusts the `gitHttpUrl` a local caller handed it, because
  // its credential helper sends a login to whatever host it trusts.
  router.get("/v1/git/host", { auth: "none" }, async () => {
    const gitHost = deps.accountAuth && !deps.accountAuth() ? null : deps.gitHost();
    if (!gitHost) throw new ApiError(503, "git_host_unavailable", "per-account git is not enabled on this deployment");
    return { body: { gitHost, gitScheme: deps.gitScheme?.() ?? "https" } };
  });

  router.get("/v1/git/authz", { auth: "none" }, async (ctx) => {
    const token = credentialFromHeader(ctx.getHeader("authorization"));
    const caller = token ? await resolveGitCaller(token, deps) : null;
    if (!caller) {
      // git reads this header to know it should ask its credential helper.
      return {
        statusCode: 401,
        headers: { "WWW-Authenticate": 'Basic realm="TeamClu"' },
        body: { error: { code: "unauthorized", message: "a TeamClu git credential is required" } },
      };
    }
    return {
      statusCode: 200,
      headers: { "X-WEBAUTH-USER": giteaUserName(caller.userId) },
      body: { ok: true },
    };
  });

  router.get("/v1/git/access", { auth: "none" }, async (ctx) => {
    const token = credentialFromHeader(ctx.getHeader("authorization"));
    const caller = token ? await resolveGitCaller(token, deps) : null;
    if (!caller) throw new ApiError(401, "unauthorized", "a TeamClu git credential is required");

    const repo = (ctx.query.get("repo") ?? "").trim().replace(/^\/+|\/+$/g, "");
    const repoName = repo.split("/").pop() ?? "";
    const appId = APP_REPO.exec(repoName)?.[1];
    if (!appId) throw new ApiError(404, "not_found", "not an app repository");

    // Outside the app's team: say nothing about the app, not even that it exists.
    const access = await readAppGitAccess(deps.admin(), appId, caller.userId);
    if (!access) throw new ApiError(404, "not_found", "app not found");
    return { body: access };
  });
}

/**
 * The per-app git routes: credentials for the machines that clone an app's
 * repo, and the repo HEAD the deploy path checks against. They moved here from
 * `routes/apps.ts` with the rest of the forge integration; the paths, bodies
 * and status codes are unchanged, and they still answer through the
 * repository, which decides who may see what.
 */
export function registerAppGitRoutes(router) {
  // Secret response — never log the body (private deploy key).
  router.get("/v1/apps/:appId/git-credential", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const out = await ctx.repository.getAppGitCredential(appId);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  // Handing a key back the moment ssh exits — see `amuxd git-ssh`. Idempotent:
  // a key already gone answers 200 with `revoked: false`, because "not usable
  // any more" is what the caller asked for either way.
  router.delete("/v1/apps/:appId/git-credential/:deployKeyId", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const deployKeyId = Number.parseInt(decodeURIComponent(ctx.params.deployKeyId), 10);
    if (!Number.isInteger(deployKeyId)) {
      throw new ApiError(400, "bad_request", "deployKeyId must be an integer");
    }
    const out = await ctx.repository.revokeAppGitCredential(appId, deployKeyId);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  // Store the token for an imported app's http(s) repo. Admin only, and
  // write-only here: the value comes back out only through GET above, to the
  // machines that clone. Secret request — never log the body.
  router.put("/v1/apps/:appId/git-credential", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const input = parseGitHttpsCredentialInput(ctx.json);
    const out = await ctx.repository.setAppGitHttpsCredential(appId, input);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  router.delete("/v1/apps/:appId/git-credential", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const out = await ctx.repository.clearAppGitHttpsCredential(appId);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  // `?compare=1` also reports how many commits the branch is ahead of what is
  // deployed. Opt-in: the deploy path calls this endpoint on every deploy and
  // reads only `sha`, so the extra forge round trip is not made for it.
  router.get("/v1/apps/:appId/git-head", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const out = await ctx.repository.getAppGitHead(appId, {
      compare: ctx.query.get("compare") === "1",
    });
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

}
