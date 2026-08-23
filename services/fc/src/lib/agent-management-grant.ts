import { SignJWT, jwtVerify } from "jose";
import { ApiError } from "./http-utils.js";

const ISSUER = "teamclu-fc";
const AUDIENCE = "teamclu-agent-management";
const TTL_SECONDS = 60;

export type AgentManagementGrantClaims = {
  teamId: string;
  requesterActorId: string;
  targetAgentId: string;
  scopes: string[];
  /**
   * The RPC `request_id` this grant may be spent on, chosen by FC and handed
   * back to the requester. The target Agent refuses the grant on any other
   * request id, and deduplicates repeats of the same one — so a captured grant
   * replays into the Agent's cached response instead of a second mutation.
   * That is the single-use property; there is no server-side nonce ledger.
   */
  nonce: string;
};

function signingKey(): Uint8Array {
  // Dedicated key only. This secret authorizes capability management on every
  // Agent in every team, so it must not be shared with the trusted-external
  // login HMAC: whoever can mint external login JWTs would otherwise be able to
  // mint management grants too, and issuer/audience separation does nothing
  // against a holder of the key itself.
  const secret = process.env.AGENT_MANAGEMENT_GRANT_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new ApiError(503, "agent_management_unavailable", "agent management grant signing is not configured");
  }
  return new TextEncoder().encode(secret);
}

export async function mintAgentManagementGrant(
  claims: AgentManagementGrantClaims,
): Promise<{ grant: string; expiresAt: string; nonce: string }> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + TTL_SECONDS;
  const grant = await new SignJWT({
    teamId: claims.teamId,
    requesterActorId: claims.requesterActorId,
    targetAgentId: claims.targetAgentId,
    scopes: claims.scopes,
    nonce: claims.nonce,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(signingKey());
  return { grant, expiresAt: new Date(expiresAt * 1000).toISOString(), nonce: claims.nonce };
}

export async function verifyAgentManagementGrant(grant: string): Promise<AgentManagementGrantClaims> {
  try {
    const { payload } = await jwtVerify(grant, signingKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
    });
    const scopes = Array.isArray(payload.scopes)
      ? payload.scopes.filter((scope): scope is string => typeof scope === "string")
      : [];
    const claims = {
      teamId: typeof payload.teamId === "string" ? payload.teamId : "",
      requesterActorId: typeof payload.requesterActorId === "string" ? payload.requesterActorId : "",
      targetAgentId: typeof payload.targetAgentId === "string" ? payload.targetAgentId : "",
      scopes,
      nonce: typeof payload.nonce === "string" ? payload.nonce : "",
    };
    if (!claims.teamId || !claims.requesterActorId || !claims.targetAgentId || !claims.nonce || scopes.length === 0) {
      throw new Error("required claims are missing");
    }
    return claims;
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    throw new ApiError(403, "invalid_agent_management_grant", "agent management grant is invalid or expired");
  }
}
