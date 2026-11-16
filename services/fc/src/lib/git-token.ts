import { SignJWT, jwtVerify } from "jose";

/**
 * The git-only credential a person's machine holds
 * (docs/specs/2026-11-16-app-platform-identity-design.md §4).
 *
 * Why not the person's TeamClu session: the token sits in a file that any
 * process of the same OS user can read (`<amuxd home>/git-token.json`). A
 * stolen session is the whole account, for as long as GoTrue keeps it alive; a
 * stolen git token is git, for at most 30 days, and dies the moment its owner
 * signs out (the epoch below).
 *
 * Revocation is a counter, not a table: `auth.users.raw_app_meta_data
 * .git_token_epoch`. A token carries the epoch it was minted under, and
 * `/v1/git/token/revoke` bumps it — every token of that account, on every
 * machine, stops working at once.
 */
export const GIT_TOKEN_AUDIENCE = "teamclu-git";
const ISSUER = "teamclu-fc";
export const GIT_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface GitTokenClaims {
  userId: string;
  epoch: number;
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** The signing secret, or null when this deployment has none (the git endpoints then answer 503). */
export function readGitTokenSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = env.GIT_TOKEN_SECRET?.trim();
  return secret && secret.length >= 32 ? secret : null;
}

export async function signGitToken(
  claims: GitTokenClaims,
  secret: string,
  now: number = Date.now(),
): Promise<{ token: string; expiresAt: string }> {
  const iat = Math.floor(now / 1000);
  const exp = iat + GIT_TOKEN_TTL_SECONDS;
  const token = await new SignJWT({ epoch: claims.epoch })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(GIT_TOKEN_AUDIENCE)
    .setSubject(claims.userId)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key(secret));
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

/** The claims of a valid, unexpired git token, or null for anything else (including a TeamClu session). */
export async function verifyGitToken(token: string, secret: string, now: number = Date.now()): Promise<GitTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: GIT_TOKEN_AUDIENCE,
      currentDate: new Date(now),
    });
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    const epoch = typeof payload.epoch === "number" && Number.isInteger(payload.epoch) ? payload.epoch : null;
    if (epoch === null) return null;
    return { userId: payload.sub, epoch };
  } catch {
    return null;
  }
}

/** The account's current epoch, from GoTrue's app metadata. Absent reads as 0. */
export function gitTokenEpochOf(user: { app_metadata?: Record<string, unknown> | null } | null | undefined): number {
  const raw = user?.app_metadata?.git_token_epoch;
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}
