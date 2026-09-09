import { ApiError } from "./http-utils.js";

/**
 * Operator-defined environment for a deployed app.
 *
 * The platform already writes a handful of variables into every function
 * (`finalizeDeploy`): the port, the database URL, the storage token and its
 * endpoints, and — for a walled app — the login variables. Those are what make
 * the app work at all, and a user variable that shadowed one would break the
 * app in a way whose cause is invisible from the inside: the app would simply
 * see the wrong DATABASE_URL and report that the database is unreachable.
 *
 * Two independent defences, because one of them is only a defence against
 * mistakes made through this API:
 *
 *  1. Reserved names are refused at write time, with the reason named. That is
 *     the one the user sees, and it is the one that teaches.
 *  2. User env is applied FIRST at finalize, and the platform's own values are
 *     assigned over it. That is the one that holds even for a row written by
 *     something other than this endpoint.
 */

/** Names the platform writes itself. Case-sensitive, like the environment. */
export const RESERVED_ENV_KEYS = new Set([
  // finalizeDeploy's own
  "PORT",
  "NODE_ENV",
  "DATABASE_URL",
  // buildPlatformAuthEnv
  "APP_PUBLIC_URL",
  "API_BASE",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
]);

/**
 * Everything the platform hands an app about ITSELF lives under this prefix
 * (`buildAppStorageEnv`), so reserving the prefix keeps the list above from
 * having to grow every time a capability is added.
 */
export const RESERVED_ENV_PREFIX = "TEAMCLU_";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_KEY_LEN = 128;
const MAX_VALUE_LEN = 8192;
/** A ceiling on the whole set, not just each row: FC caps a function's env. */
export const MAX_ENV_VARS_PER_APP = 100;

export function isReservedEnvKey(key: string): boolean {
  return RESERVED_ENV_KEYS.has(key) || key.startsWith(RESERVED_ENV_PREFIX);
}

/**
 * Validate one variable name.
 *
 * Not trimmed-and-accepted: a key with a leading space is a key the runtime
 * will never find, and silently repairing it would leave the operator looking
 * at a variable that reads correctly in the panel and does not exist in the
 * process.
 */
export function parseEnvKey(raw: unknown): string {
  if (typeof raw !== "string" || !raw) {
    throw new ApiError(400, "validation_failed", "env key is required");
  }
  if (raw.length > MAX_KEY_LEN) {
    throw new ApiError(400, "validation_failed", `env key is longer than ${MAX_KEY_LEN} characters`);
  }
  if (!KEY_RE.test(raw)) {
    throw new ApiError(
      400,
      "validation_failed",
      `env key must be letters, digits and underscores, not starting with a digit: ${raw}`,
    );
  }
  if (isReservedEnvKey(raw)) {
    throw new ApiError(
      400,
      "env_key_reserved",
      `${raw} is set by the platform and cannot be overridden`,
    );
  }
  return raw;
}

export function parseEnvValue(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ApiError(400, "validation_failed", "env value must be a string");
  }
  if (raw.length > MAX_VALUE_LEN) {
    throw new ApiError(400, "validation_failed", `env value is larger than ${MAX_VALUE_LEN} bytes`);
  }
  // A newline in a function's environment is accepted by FC and then mangled by
  // most things that read it back; refusing is kinder than the debugging.
  if (/[\r\n\0]/.test(raw)) {
    throw new ApiError(400, "validation_failed", "env value cannot contain newlines or NUL");
  }
  return raw;
}

/**
 * The platform's variables, laid over the operator's.
 *
 * Order is the point: `Object.assign(user, platform)` — never the other way —
 * so a user row that reached the table without passing `parseEnvKey` (a direct
 * database write, a migration, a future endpoint) still cannot take DATABASE_URL
 * away from the app.
 */
export function mergeAppEnv(
  userEnv: Record<string, string>,
  platformEnv: Record<string, string>,
): Record<string, string> {
  return Object.assign({}, userEnv, platformEnv);
}
