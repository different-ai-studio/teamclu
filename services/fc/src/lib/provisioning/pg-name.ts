// Postgres identifiers are max 63 bytes. Names are interpolated into DDL
// (CREATE SCHEMA/ROLE/DATABASE cannot be parameterized), so callers re-assert
// the output matches /^[a-z0-9_]+$/ before use; the sanitizer guarantees that
// here.
const MAX_LEN = 63;

function sanitize(input: string, prefix: string): string {
  const body = input.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return `${prefix}${body}`.slice(0, MAX_LEN);
}

/** Hex-only form of a UUID (or any id), for embedding in identifiers. */
function idHex(id: string): string {
  return id.replace(/[^a-f0-9]/gi, "").toLowerCase();
}

// The role name is derived from the globally-unique appId, so it is unique
// across the whole Postgres cluster (roles are cluster-scoped).
export function appRoleName(appId: string): string {
  return sanitize(appId, "app_");
}

// One schema per app, inside the org's database. Layout:
// app_<slug>_<appIdHex>, with the slug truncated so the full 32-char appId hex
// suffix always fits within 63 bytes (4 + 26 + 1 + 32 = 63).
export function appSchemaName(slug: string, appId: string): string {
  const hex = idHex(appId);
  const slugBody = slug.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 26);
  return `app_${slugBody}_${hex}`.slice(0, MAX_LEN);
}

/**
 * One database per org (`public.orgs.id`). Layout: `tc_org_<orgIdHex>`.
 *
 * Hex-only so CREATE DATABASE never sees a hyphen. Prefix keeps the name
 * recognisable next to supabase/litellm DBs on the same instance.
 */
export function orgDatabaseName(orgId: string): string {
  const hex = idHex(orgId);
  if (!hex) throw new Error("orgId must contain hex digits");
  return `tc_org_${hex}`.slice(0, MAX_LEN);
}
