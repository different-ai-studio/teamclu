/**
 * ESP32 device pairing — Cloud API side of plan §8.1.
 *
 * Flow: amuxd mints a code → FC stores sha256(code) → device redeems for a
 * one-shot deviceSecret → device exchanges secret for short-lived MQTT JWTs.
 *
 * Neither the pairing code nor the device secret is persisted in the clear;
 * both tables are service-role only (migration 20260824000000_device_pairing).
 */
import { createHash, randomBytes } from "node:crypto";
import { ApiError } from "./http-utils.js";
import { mintDeviceMqttJwt } from "./device-mqtt-jwt.js";

const DEFAULT_TTL_SECONDS = 600;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 3600;
const DEVICE_ID_RE = /^[0-9a-f]{4,32}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function generateDeviceSecret(): string {
  // 32 bytes → 64 hex chars. High entropy; used as an unsalted lookup key.
  return randomBytes(32).toString("hex");
}

type ServiceClient = {
  from: (table: string) => any;
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
};

export type DevicePairingDeps = {
  createServiceRoleClient?: () => ServiceClient | Promise<ServiceClient>;
};

async function adminClient(deps: DevicePairingDeps, what: string): Promise<ServiceClient> {
  if (deps.createServiceRoleClient) {
    return await deps.createServiceRoleClient();
  }
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!serviceKey) {
    throw new ApiError(503, "unavailable", `SUPABASE_SERVICE_ROLE_KEY is not configured; cannot ${what}`);
  }
  const { createServiceRoleClient } = await import("./supabase.js");
  return createServiceRoleClient() as unknown as ServiceClient;
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new ApiError(400, "validation_failed", `${field} must be a uuid`);
  }
  return value;
}

function requireCode(value: unknown): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "validation_failed", "code is required");
  }
  const code = value.trim();
  // Short capability token: reject empties and absurd lengths (JWT paste leftovers).
  if (code.length < 4 || code.length > 64) {
    throw new ApiError(400, "validation_failed", "code must be 4–64 characters");
  }
  return code;
}

function requireDeviceId(value: unknown): string {
  if (typeof value !== "string" || !DEVICE_ID_RE.test(value)) {
    throw new ApiError(
      400,
      "validation_failed",
      "deviceId must be 4–32 lowercase hex characters",
    );
  }
  return value;
}

function clampTtl(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_TTL_SECONDS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_TTL_SECONDS || n > MAX_TTL_SECONDS) {
    throw new ApiError(
      400,
      "validation_failed",
      `ttlSeconds must be an integer from ${MIN_TTL_SECONDS} to ${MAX_TTL_SECONDS}`,
    );
  }
  return n;
}

export type CreatePairingCodeInput = {
  code: string;
  teamId: string;
  actorId: string;
  ttlSeconds?: number;
  createdBy?: string | null;
};

export async function createDevicePairingCode(
  input: CreatePairingCodeInput,
  deps: DevicePairingDeps = {},
) {
  const code = requireCode(input.code);
  const teamId = requireUuid(input.teamId, "teamId");
  const actorId = requireUuid(input.actorId, "actorId");
  const ttlSeconds = clampTtl(input.ttlSeconds);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const codeHash = sha256Hex(code);

  const admin = await adminClient(deps, "register a device pairing code");
  const { error } = await admin.from("device_pairing_codes").insert({
    code_hash: codeHash,
    team_id: teamId,
    actor_id: actorId,
    created_by: input.createdBy ?? null,
    expires_at: expiresAt,
  });

  if (error) {
    // Unique on code_hash — a duplicate mint of the same code is a client bug.
    const msg = typeof error === "object" && error && "message" in error
      ? String((error as { message: string }).message)
      : "failed to store pairing code";
    if (/duplicate|unique/i.test(msg)) {
      throw new ApiError(409, "pairing_code_conflict", "pairing code already registered");
    }
    throw new ApiError(500, "internal_error", msg);
  }

  return {
    code,
    teamId,
    actorId,
    ttlSeconds,
    expiresAt,
  };
}

export type RedeemPairingCodeInput = {
  code: string;
  deviceId: string;
  model?: string;
  fw?: string;
};

export async function redeemDevicePairingCode(
  input: RedeemPairingCodeInput,
  deps: DevicePairingDeps = {},
) {
  const code = requireCode(input.code);
  const deviceId = requireDeviceId(input.deviceId);
  const model =
    typeof input.model === "string" && input.model.trim() ? input.model.trim().slice(0, 64) : "unknown";
  const firmware =
    typeof input.fw === "string" && input.fw.trim() ? input.fw.trim().slice(0, 64) : "";

  const codeHash = sha256Hex(code);
  const admin = await adminClient(deps, "redeem a device pairing code");

  const { data: row, error: lookupErr } = await admin
    .from("device_pairing_codes")
    .select("id, team_id, actor_id, expires_at, redeemed_at")
    .eq("code_hash", codeHash)
    .maybeSingle();

  if (lookupErr) {
    throw new ApiError(500, "internal_error", String(lookupErr.message ?? lookupErr));
  }
  if (!row) {
    throw new ApiError(404, "pairing_code_not_found", "pairing code not found");
  }
  if (row.redeemed_at) {
    throw new ApiError(409, "pairing_code_redeemed", "pairing code already redeemed");
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    throw new ApiError(409, "pairing_code_expired", "pairing code expired");
  }

  const deviceSecret = generateDeviceSecret();
  const secretHash = sha256Hex(deviceSecret);

  // Insert device first; if the id is already paired, refuse before burning the code.
  const { error: deviceErr } = await admin.from("devices").insert({
    id: deviceId,
    team_id: row.team_id,
    actor_id: row.actor_id,
    secret_hash: secretHash,
    model,
    firmware,
  });

  if (deviceErr) {
    const msg = String(deviceErr.message ?? deviceErr);
    if (/duplicate|unique|devices_pkey/i.test(msg)) {
      throw new ApiError(409, "device_already_paired", "device is already paired; re-pair after revoke");
    }
    throw new ApiError(500, "internal_error", msg);
  }

  const redeemedAt = new Date().toISOString();
  const { data: marked, error: markErr } = await admin
    .from("device_pairing_codes")
    .update({
      redeemed_at: redeemedAt,
      redeemed_by_device: deviceId,
    })
    .eq("id", row.id)
    .is("redeemed_at", null)
    .select("id")
    .maybeSingle();

  if (markErr) {
    // Device row exists without a burned code — best-effort cleanup.
    await admin.from("devices").delete().eq("id", deviceId).eq("secret_hash", secretHash);
    throw new ApiError(500, "internal_error", String(markErr.message ?? markErr));
  }
  if (!marked) {
    // Lost the race: another redeem burned the code between our lookup and update.
    await admin.from("devices").delete().eq("id", deviceId).eq("secret_hash", secretHash);
    throw new ApiError(409, "pairing_code_redeemed", "pairing code already redeemed");
  }

  // Best-effort housekeeping; never fail the redeem on purge errors.
  try {
    await admin.rpc("purge_stale_device_pairing_codes");
  } catch {
    /* ignore */
  }

  return {
    deviceSecret,
    teamId: row.team_id as string,
    actorId: row.actor_id as string,
  };
}

export type MintDeviceTokenInput = {
  deviceSecret: string;
  deviceId?: string;
};

export async function mintDeviceAccessToken(
  input: MintDeviceTokenInput,
  deps: DevicePairingDeps = {},
) {
  if (typeof input.deviceSecret !== "string" || input.deviceSecret.trim().length < 16) {
    throw new ApiError(400, "validation_failed", "deviceSecret is required");
  }
  const secretHash = sha256Hex(input.deviceSecret.trim());
  const admin = await adminClient(deps, "mint a device MQTT token");

  let query = admin
    .from("devices")
    .select("id, team_id, actor_id, revoked_at")
    .eq("secret_hash", secretHash);

  if (typeof input.deviceId === "string" && input.deviceId.trim()) {
    query = query.eq("id", requireDeviceId(input.deviceId.trim()));
  }

  const { data: device, error } = await query.maybeSingle();
  if (error) {
    throw new ApiError(500, "internal_error", String(error.message ?? error));
  }
  if (!device) {
    throw new ApiError(401, "invalid_device_secret", "device secret is not recognised");
  }
  if (device.revoked_at) {
    throw new ApiError(403, "device_revoked", "device has been revoked");
  }

  // Touch last_seen — failure here must not block the token.
  try {
    await admin
      .from("devices")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", device.id);
  } catch {
    /* ignore */
  }

  const minted = await mintDeviceMqttJwt({
    teamId: device.team_id,
    actorId: device.actor_id,
    deviceId: device.id,
  });

  return {
    accessToken: minted.accessToken,
    expiresAt: minted.expiresAt,
    ...(minted.broker ? { broker: minted.broker } : {}),
    teamId: device.team_id as string,
    actorId: device.actor_id as string,
  };
}
