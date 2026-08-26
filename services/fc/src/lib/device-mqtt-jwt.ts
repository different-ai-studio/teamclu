/**
 * Short-lived MQTT JWTs for paired ESP32 voice terminals.
 *
 * Signed with `EMQX_JWT_SECRET`, base64-decoded — the key the broker's ONE
 * existing JWT authenticator already trusts.
 *
 * A dedicated `DEVICE_MQTT_JWT_SECRET` was tried and cannot work: EMQX here has
 * exactly one authenticator (`deploy/self-host/emqx/emqx.conf`), and adding a
 * second was ruled out. Every device token signed with a different key comes
 * back as CONNACK rc=5 and the device is permanently offline — a failure with
 * no diagnostic on the device beyond "connect refused".
 *
 * The base64 decode is not incidental either: that authenticator sets
 * `secret_base64_encoded = true`, so it decodes its configured copy before
 * verifying. Signing over the raw UTF-8 bytes fails against the same key.
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
  const secret = process.env.EMQX_JWT_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new ApiError(
      503,
      "device_mqtt_unavailable",
      "EMQX_JWT_SECRET is not configured",
    );
  }
  // Matches `secret_base64_encoded = true` on the broker's authenticator.
  return Buffer.from(secret, "base64");
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
