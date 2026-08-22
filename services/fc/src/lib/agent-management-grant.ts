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
  nonce: string;
};

function signingKey(): Uint8Array {
  // Dedicated key is preferred. Trusted-external JWT deployments already
  // provision a high-entropy HMAC secret; accepting it as a migration fallback
  // keeps existing self-hosts working while issuer+audience domain-separate the
  // resulting tokens from external login JWTs.
  const secret = (process.env.AGENT_MANAGEMENT_GRANT_SECRET || process.env.TRUSTED_EXTERNAL_JWT_SECRET)?.trim();
  if (!secret || secret.length < 32) {
    throw new ApiError(503, "agent_management_unavailable", "agent management grant signing is not configured");
  }
  return new TextEncoder().encode(secret);
}

export async function mintAgentManagementGrant(
  claims: AgentManagementGrantClaims,
): Promise<{ grant: string; expiresAt: string }> {
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
  return { grant, expiresAt: new Date(expiresAt * 1000).toISOString() };
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
