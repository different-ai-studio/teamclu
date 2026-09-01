/**
 * Team MCP catalog — request validation.
 *
 * Design: docs/architecture/team-mcp-and-env-cloud.md
 *
 * Pure request-shape rules, deliberately free of any database access so the
 * route layer and every repository implementation apply exactly one copy of
 * them. Two things worth knowing before editing:
 *
 * 1. Adding a server to the catalog is NOT the same as running it. A server
 *    only reaches a member's machine once that member installs it, and you can
 *    only install for yourself. That split is the whole security model here:
 *    `command` is spawned locally, so "any member can write the catalog" is
 *    only safe because writing the catalog does not execute anything.
 *
 * 2. Secret-looking values in `env`/`headers` are rejected outright. The
 *    `${KEY}` placeholder convention (resolved at runtime from the encrypted
 *    team env store, see crates/teamclu-runtime-env/src/mcp_resolve.rs) used
 *    to be an unenforced suggestion while this data rode an encrypted OSS blob.
 *    Now that it lands in a server-readable column, the convention becomes a
 *    contract — see assertNoLiteralSecrets.
 */

import { ApiError } from "../http-utils.js";

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const TRANSPORTS = ["local", "remote"] as const;

/**
 * Key names that must never carry a literal value. Deliberately matched on the
 * *key* rather than sniffing the value: a heuristic over values either misses
 * short tokens or rejects legitimate config, whereas the key name is what the
 * author controls and understands.
 */
const SECRET_KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

/** `${FOO}` or `$FOO` — the forms mcp_resolve.rs substitutes at runtime. */
const PLACEHOLDER_RE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$|^\$[A-Za-z_][A-Za-z0-9_]*$/;

function asStringMap(value: unknown, label: string): Record<string, string> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "validation_failed", `${label} must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string") {
      throw new ApiError(400, "validation_failed", `${label}.${k} must be a string`);
    }
    out[k] = v;
  }
  return out;
}

/**
 * The hard gate on secrets. Rejects rather than warns: a warning that lands in
 * a shared server is a secret that has already leaked by the time anyone reads
 * it.
 *
 * Exported for direct unit testing — this is the security-relevant rule in this
 * module and deserves coverage that does not depend on a database or on the
 * authorisation that (correctly) runs before it.
 */
export function assertNoLiteralSecrets(map: Record<string, string> | null, label: string) {
  if (!map) return;
  for (const [k, v] of Object.entries(map)) {
    if (!SECRET_KEY_RE.test(k)) continue;
    if (PLACEHOLDER_RE.test(v.trim())) continue;
    throw new ApiError(
      422,
      "literal_secret_rejected",
      `${label}.${k} looks like a secret and must use a \${KEY} placeholder resolved from team env, not a literal value`,
    );
  }
}

/**
 * Validate + normalise a create/update body. On update (`partial`) only the
 * supplied fields are touched, but transport-dependent required fields are
 * re-checked against the merged result by the caller.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readServerFields(body: any, { partial = false } = {}) {
  const out: Record<string, unknown> = {};

  if (body.transport !== undefined || !partial) {
    const transport = String(body.transport ?? "").trim();
    if (!TRANSPORTS.includes(transport as never)) {
      throw new ApiError(400, "validation_failed", `transport must be one of: ${TRANSPORTS.join(", ")}`);
    }
    out.transport = transport;
  }

  if (body.command !== undefined) {
    out.command = body.command === null ? null : String(body.command).trim() || null;
  }
  if (body.args !== undefined) {
    if (body.args !== null && !Array.isArray(body.args)) {
      throw new ApiError(400, "validation_failed", "args must be an array of strings");
    }
    if (Array.isArray(body.args) && body.args.some((a: unknown) => typeof a !== "string")) {
      throw new ApiError(400, "validation_failed", "args must be an array of strings");
    }
    out.args = body.args ?? null;
  }
  if (body.url !== undefined) {
    out.url = body.url === null ? null : String(body.url).trim() || null;
  }
  if (body.headers !== undefined) {
    const headers = asStringMap(body.headers, "headers");
    assertNoLiteralSecrets(headers, "headers");
    out.headers = headers;
  }
  if (body.env !== undefined) {
    const env = asStringMap(body.env, "env");
    assertNoLiteralSecrets(env, "env");
    out.env = env;
  }
  if (body.description !== undefined) {
    out.description = body.description === null ? null : String(body.description).trim() || null;
  }

  return out;
}

/** Mirrors the transport/field CHECK constraints so the error is a 400, not a 23514. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function assertTransportShape(merged: { transport: string; command?: any; url?: any }) {
  if (merged.transport === "local" && !merged.command) {
    throw new ApiError(400, "validation_failed", "local transport requires a command");
  }
  if (merged.transport === "local" && merged.url) {
    throw new ApiError(400, "validation_failed", "local transport must not set a url");
  }
  if (merged.transport === "remote" && !merged.url) {
    throw new ApiError(400, "validation_failed", "remote transport requires a url");
  }
  if (merged.transport === "remote" && merged.command) {
    throw new ApiError(400, "validation_failed", "remote transport must not set a command");
  }
}
