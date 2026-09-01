import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ApiError } from "../http-utils.js";

type Env = NodeJS.ProcessEnv;

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

/** Kind for the platform OAuth client's confidential secret (§6.3). */
export const OAUTH_CLIENT_SECRET_KIND = "oauth_client_secret";

/**
 * 32-byte base64 AES-GCM key from env. Blank means app_secrets encrypt/decrypt
 * is unavailable until the operator configures it.
 */
export function readAppSecretsEncryptionKey(env: Env = process.env): string | undefined {
  const key = env.APP_SECRETS_ENCRYPTION_KEY?.trim();
  return key || undefined;
}

export function appSecretsUnavailable(reason?: string): ApiError {
  return new ApiError(
    503,
    "app_secrets_unavailable",
    reason ? `app secrets not configured: ${reason}` : "app secrets not configured",
  );
}

/** Decode and validate the deployment encryption key; 503 names the var when missing. */
export function requireAppSecretsEncryptionKey(env: Env = process.env): Buffer {
  const b64 = readAppSecretsEncryptionKey(env);
  if (!b64) throw appSecretsUnavailable("APP_SECRETS_ENCRYPTION_KEY is empty");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) {
    throw appSecretsUnavailable("APP_SECRETS_ENCRYPTION_KEY must decode to 32 bytes");
  }
  return key;
}

/**
 * AES-256-GCM seal. Ciphertext is base64(iv || authTag || ciphertext); `kind`
 * is bound as AAD so a row cannot be replayed under another secret kind.
 */
export function seal(kind: string, plaintext: string, env: Env = process.env): string {
  const key = requireAppSecretsEncryptionKey(env);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  cipher.setAAD(Buffer.from(kind, "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/** Decrypt a seal() payload; throws when AAD/kind or integrity check fails. */
export function open(kind: string, ciphertext: string, env: Env = process.env): string {
  const key = requireAppSecretsEncryptionKey(env);
  const buf = Buffer.from(ciphertext, "base64");
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new ApiError(500, "app_secret_corrupt", "ciphertext is too short");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAAD(Buffer.from(kind, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** Upsert via Supabase service role (amux.app_secrets). */
export async function putAppSecretSupabase(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  appId: string,
  kind: string,
  plaintext: string,
): Promise<void> {
  const ciphertext = seal(kind, plaintext);
  const { error } = await admin.from("app_secrets").upsert(
    { app_id: appId, kind, ciphertext, updated_at: new Date().toISOString() },
    { onConflict: "app_id,kind" },
  );
  if (error) throw error;
}

export async function getAppSecretSupabase(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  appId: string,
  kind: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("app_secrets")
    .select("ciphertext")
    .eq("app_id", appId)
    .eq("kind", kind)
    .maybeSingle();
  if (error) throw error;
  if (!data?.ciphertext) return null;
  return open(kind, data.ciphertext);
}

export async function deleteAppSecretSupabase(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  appId: string,
  kind: string,
): Promise<void> {
  const { error } = await admin.from("app_secrets").delete().eq("app_id", appId).eq("kind", kind);
  if (error) throw error;
}
