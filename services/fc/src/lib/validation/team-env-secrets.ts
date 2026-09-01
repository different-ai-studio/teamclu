/**
 * Team env secrets — request validation.
 *
 * Design: docs/architecture/team-mcp-and-env-cloud.md
 *
 * The store deliberately knows nothing about the values it holds. The client
 * encrypts with the team key (AES-256-GCM, HKDF-SHA256 derived — see
 * crates/teamclu-runtime-env/src/team_crypto.rs) and uploads only the envelope
 * `{v, nonce, ciphertext}`. That is the same threat model the previous OSS/git
 * storage had — it defends against whoever runs the storage, not against
 * teammates — so moving the bytes to Postgres changed the transport, not the
 * guarantees.
 *
 * The practical consequence: every field the server needs for authorisation has
 * to be its own plaintext column. `description`, `category`, `createdBy` and
 * friends all live *inside* the ciphertext (SecretEntry), so the `created_by`
 * column is not redundant with them — it is the only copy the server can
 * actually read when deciding who may delete a key.
 */

import { ApiError } from "../http-utils.js";

/** Same rule as the desktop `validate_key_id`. */
const KEY_ID_RE = /^[a-z0-9_]{1,64}$/;

/**
 * Reserved internal keys that must never reach the team store. `tc_api_key` is
 * already skipped daemon-side (apps/daemon/src/team_shared_env.rs), and
 * `_team_secret.*` is the team key itself — uploading it would hand the server
 * the means to decrypt every other row.
 *
 * The dotted form `_team_secret.<team_id>` is already unreachable, since
 * KEY_ID_RE forbids `.`; the prefix check catches the bare name and any future
 * variant, and costs nothing.
 */
export function assertWritableKeyId(keyId: string) {
  if (!KEY_ID_RE.test(keyId)) {
    throw new ApiError(
      400,
      "validation_failed",
      "keyId must be 1-64 chars of lowercase letters, digits, or underscores",
    );
  }
  if (keyId === "tc_api_key" || keyId.startsWith("_team_secret")) {
    throw new ApiError(422, "reserved_key", `${keyId} is reserved and cannot be shared to a team`);
  }
}

/**
 * Structural check only — we cannot verify the ciphertext decrypts (no key),
 * but we can refuse anything that is obviously not an envelope. Without this a
 * client bug that posts the plaintext would be stored verbatim and silently
 * become a server-readable secret.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readEnvelope(body: any): { v: number; nonce: string; ciphertext: string } {
  const env = body?.envelope;
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new ApiError(400, "validation_failed", "envelope must be an object");
  }
  const v = Number(env.v);
  if (!Number.isInteger(v) || v < 1) {
    throw new ApiError(400, "validation_failed", "envelope.v must be a positive integer");
  }
  const nonce = String(env.nonce ?? "");
  const ciphertext = String(env.ciphertext ?? "");
  if (!nonce || !ciphertext) {
    throw new ApiError(400, "validation_failed", "envelope.nonce and envelope.ciphertext are required");
  }
  // Anything beyond the three known fields is dropped rather than stored: an
  // unexpected key here is far more likely to be leaked plaintext than a
  // forward-compatible extension.
  return { v, nonce, ciphertext };
}
