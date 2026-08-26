/**
 * Short-lived MQTT JWTs for paired ESP32 voice terminals.
 *
 * Signed with a dedicated `DEVICE_MQTT_JWT_SECRET` — shared only between FC
 * (mint) and EMQX (second authenticator). Deliberately not the Supabase or
 * trusted-external secrets: see plan §8.1 and agent-management-grant.ts.
 *
 * Claim names `team` / `actor` match what firmware already decodes for topic
 * construction; `team_id` / `actor_id` are aliases for EMQX ACL templates.
 */
import { SignJWT } from "jose";
import { ApiError } from "./http-utils.js";

const ISSUER = "teamclu-fc";
const AUDIENCE = "teamclu-device-mqtt";
/** Default lifetime for a device MQTT JWT (seconds). */
export const DEVICE_MQTT_JWT_TTL_SECONDS = 3600;

export type DeviceMqttJwtClaims = {
  teamId: string;
  actorId: string;
  deviceId: string;
  broker?: string;
};

function signingKey(): Uint8Array {
  const secret = process.env.DEVICE_MQTT_JWT_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new ApiError(
      503,
      "device_mqtt_unavailable",
      "DEVICE_MQTT_JWT_SECRET is not configured",
    );
  }
  return new TextEncoder().encode(secret);
}

function brokerUrl(): string | undefined {
  const url = process.env.MQTT_BROKER_URL?.trim();
  return url || undefined;
}

export async function mintDeviceMqttJwt(
  claims: DeviceMqttJwtClaims,
  ttlSeconds: number = DEVICE_MQTT_JWT_TTL_SECONDS,
): Promise<{ accessToken: string; expiresAt: string; broker?: string }> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttlSeconds;
  const broker = claims.broker ?? brokerUrl();

  const accessToken = await new SignJWT({
    team: claims.teamId,
    actor: claims.actorId,
    team_id: claims.teamId,
    actor_id: claims.actorId,
    device_id: claims.deviceId,
    ...(broker ? { broker } : {}),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(claims.deviceId)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(signingKey());

  return {
    accessToken,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    ...(broker ? { broker } : {}),
  };
}
