import { createHash } from "node:crypto";
import { ApiError } from "../http-utils.js";
import { createServiceRoleClient } from "../supabase.js";
import { verifyTrustedExternalJwt } from "../trusted-external-jwt.js";
import { appLevelAtLeast, storedAppPermissionLevel, type AppPermissionLevel } from "../app-permission.js";
import {
  gitTokenEpochOf,
  readGitTokenSecret,
  signGitToken,
  verifyGitToken,
  GIT_TOKEN_TTL_SECONDS,
} from "../git-token.js";
import { giteaUserName } from "../provisioning/gitea.js";
import { giteaAccountAuthEnabled } from "../provisioning/gitea-sync-runner.js";

/**
 * Per-account git over HTTPS (docs/specs/2026-11-16-app-platform-identity-design.md §4, §6).
 *
 *   POST /v1/git/token          a person's machine gets its git-only token
 *   POST /v1/git/token/revoke   sign-out: every git token of the account dies
 *   GET  /v1/git/authz          Caddy forward_auth: who is this git request?
 *   GET  /v1/git/access         the credential helper: why was I refused?
 *
 * All four authenticate themselves (route `auth: "none"`): the credential is
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
 */
const CACHE_TTL_MS = 60_000;
const callerCache = new Map<string, { caller: Caller | null; until: number }>();

export function resetGitCallerCache() {
  callerCache.clear();
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
  const admin = deps.admin();
  const secret = deps.secret();
  const claims = secret ? await verifyGitToken(token, secret, now) : null;
  if (claims) {
    // A git token is only as good as the account behind it right now: gone,
    // banned, or signed out since (epoch moved on) all mean no.
    const { data, error } = await admin.auth.admin.getUserById(claims.userId);
    const user = data?.user;
    if (!error && user && !isBanned(user, now) && gitTokenEpochOf(user) === claims.epoch) {
      caller = { userId: user.id, via: "git_token" };
    }
  } else {
    // An agent's own TeamClu login token, handed to it by its daemon.
    const { data, error } = await admin.auth.getUser(token);
    if (!error && data?.user?.id && !isBanned(data.user, now)) {
      caller = { userId: data.user.id, via: "login_token" };
    } else {
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
  callerCache.set(cacheKey, { caller, until: now + CACHE_TTL_MS });
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

    const admin = deps.admin();
    const { data: app } = await admin
      .from("apps")
      .select("id, name, team_id, visibility, created_by_actor_id")
      .eq("id", appId)
      .maybeSingle();
    if (!app) throw new ApiError(404, "not_found", "app not found");
    const { data: actor } = await admin
      .from("actors")
      .select("id, actor_type, display_name")
      .eq("team_id", app.team_id)
      .eq("user_id", caller.userId)
      .maybeSingle();
    // Outside the app's team: say nothing about the app, not even that it exists.
    if (!actor) throw new ApiError(404, "not_found", "app not found");

    let permission: AppPermissionLevel | null = null;
    if (app.created_by_actor_id === actor.id) permission = "admin";
    else {
      const { data: grant } = await admin
        .from("app_member_access")
        .select("permission_level")
        .eq("app_id", app.id)
        .eq("member_id", actor.id)
        .maybeSingle();
      permission = storedAppPermissionLevel(grant?.permission_level);
      if (app.visibility === "team" && (!permission || !appLevelAtLeast(permission, "read"))) permission = "read";
    }
    return {
      body: {
        appId: app.id,
        appName: app.name,
        permission,
        actorName: actor.display_name ?? null,
        actorType: actor.actor_type,
      },
    };
  });
}
