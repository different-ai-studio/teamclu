// services/fc/src/lib/sync-acl.ts
//
// Per-directory access control for the knowledge vault.
// Design: docs/specs/2026-08-31-knowledge-path-acl-design.md
//
// ## This module is the only place that decides who may see what
//
// That is a hard rule, not a style preference. Two reasons:
//
//   1. Permission logic scattered across five handlers can never be shown to be
//      consistent. Here it is one function with one test suite.
//   2. If the knowledge backend is ever replaced, this module and two tables are
//      the whole migration surface.
//
// Handlers call `deniedPrefixesFor` once and pass the result down. They must not
// query `amuxc_path_acl` themselves.
//
// ## Semantics (design D5)
//
// Whitelist: a prefix with a row in `amuxc_path_acl` is closed to every actor
// without a matching `amuxc_path_acl_grants` row. Overlapping rules intersect —
// the strictest wins, which falls out of "denied if ANY covering rule lacks a
// grant" without needing an ordering pass.
//
// A team with no rules is the overwhelmingly common case, and it must stay free:
// `deniedPrefixesFor` returns `[]` and every caller then runs exactly the query
// it ran before this feature existed. Manifest is the hottest endpoint in the
// product; it does not get to pay for a feature it is not using.
//
// ## What this is NOT
//
// Not confidentiality from the operator. Knowledge content is stored in
// plaintext (ADR-0008); anyone with database or object-store access reads
// everything. This is in-team access control, and revocation stops distribution
// rather than recalling what was already synced.

import { createServiceRoleClient } from './supabase.js';

/** Audit actions, matching the CHECK constraint on `amuxc_access_log.action`. */
export type AclAction = 'manifest' | 'download' | 'upload' | 'delete' | 'versions';

export interface SyncAclDeps {
  /**
   * Service-role client override. Production omits it and gets
   * `createServiceRoleClient()`; tests pass a stub so the rules this module
   * enforces can be exercised without a database. Injected rather than
   * module-mocked because every other seam in this path (storage, repo, mqtt)
   * already works this way.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase?: any;
  /**
   * Clock override for cache expiry (tests), in epoch milliseconds.
   *
   * Named `nowMs` rather than `now` on purpose: `SyncHandlerDeps` already has a
   * `now?: () => Date` for MQTT hint timestamps and gets passed straight through
   * to these functions. Two clocks with the same name and different return types
   * would make that pass-through a type error at every call site.
   */
  nowMs?: () => number;
}

/**
 * What one team's rules mean for one caller.
 *
 * `denied` drives filtering; `allPrefixes` exists only so the audit path can ask
 * "did this request touch restricted ground at all?" without a second query —
 * including for callers who ARE allowed, whose accesses are exactly what the
 * audit is for.
 */
export interface AclView {
  /** Prefixes this caller may NOT see. Empty => unrestricted. */
  denied: string[];
  /** Every restricted prefix in the team, grant or no grant. */
  allPrefixes: string[];
}

const EMPTY_VIEW: AclView = Object.freeze({ denied: [], allPrefixes: [] });

/**
 * Largest number of rules one team may hold.
 *
 * Each rule becomes one `NOT LIKE` on the manifest query, so this is a bound on
 * how much a single team can slow the hottest endpoint down. Sized against
 * reality rather than theory: the largest knowledge base in production is a
 * two-digit file count, so 64 restricted directories is far past any plausible
 * need and still leaves the SQL trivial.
 */
export const MAX_ACL_RULES_PER_TEAM = 64;

/**
 * Roots a rule prefix may name — the two fixed directories of the synced tree.
 *
 * Kept in step with `ALLOWED_PREFIXES` in sync-path.ts and with the SQL CHECK
 * on `amuxc_path_acl`. A prefix outside these names a path the sync engine will
 * never carry, so a rule against it could never do anything.
 */
export const ALLOWED_ACL_ROOTS = ['documents/', 'knowledge/'] as const;

// ---------------------------------------------------------------------------
// Cache
//
// Keyed per (team, actor) because `denied` is actor-specific. 10s, matching the
// pattern in sync-guards.ts.
//
// The staleness this introduces is bounded by the TTL, and it does not weaken
// any security property we actually claim: revocation already cannot recall
// copies that have been synced (design D6), so a revocation taking up to ten
// extra seconds to bite changes nothing that was ever promised.
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 10_000;
const viewCache = new Map<string, { at: number; view: AclView }>();

/** Drop cached ACL views. Tests, and after any rule mutation. */
export function resetSyncAclCache(): void {
  viewCache.clear();
}

/**
 * Invalidate one team's cached views.
 *
 * Called by the management API after a rule change so an admin who just granted
 * access does not have to wait out the TTL to see it work. Scans the map because
 * it is keyed by (team, actor) and a team has few actors; a team-keyed index
 * would be more bookkeeping than the scan costs at this size.
 */
export function invalidateTeamAcl(teamId: string): void {
  for (const key of viewCache.keys()) {
    if (key.startsWith(`${teamId}:`)) viewCache.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Path matching
// ---------------------------------------------------------------------------

/**
 * The restricted prefix covering `path`, or `null`.
 *
 * Every stored prefix ends with `/` (CHECKed in SQL), which is what makes a
 * plain `startsWith` segment-correct: `knowledge/hr/` cannot match
 * `knowledge/hr-public/notes.md`. Do not "simplify" this by trimming the
 * trailing slash — that reintroduces the bug the constraint exists to prevent.
 *
 * Returns the FIRST match. Callers that only need a boolean ignore which one;
 * the audit path uses it to record the rule that fired.
 */
export function matchPrefix(path: string, prefixes: string[]): string | null {
  for (const prefix of prefixes) {
    if (path.startsWith(prefix)) return prefix;
  }
  return null;
}

/** Whether `path` is closed to this caller. Thin wrapper for readability. */
export function isDenied(path: string, view: AclView): boolean {
  return view.denied.length > 0 && matchPrefix(path, view.denied) !== null;
}

/**
 * Validate a prefix before it is stored.
 *
 * Duplicates the SQL CHECK on purpose: the constraint is the backstop, but a
 * 422 with an explanation beats a raw constraint-violation 500 in an admin UI.
 */
// Return shape mirrors `validateSyncPath` — a flat `{ ok, message? }` rather
// than a discriminated union, because this project compiles with `strict: false`
// and boolean-literal narrowing does not survive that setting.
export function validateAclPrefix(prefix: unknown): { ok: boolean; message?: string } {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    return { ok: false, message: 'pathPrefix is required' };
  }
  // Both synced roots are accepted. Only `documents/` gets a UI entry point,
  // but that is editorial policy — see the migration widening the matching SQL
  // constraint for why it is not enforced down here.
  if (!ALLOWED_ACL_ROOTS.some((root) => prefix.startsWith(root))) {
    return {
      ok: false,
      message: `pathPrefix must start with one of: ${ALLOWED_ACL_ROOTS.join(', ')}`,
    };
  }
  if (!prefix.endsWith('/')) {
    return { ok: false, message: 'pathPrefix must end with "/" so it matches on a path boundary' };
  }
  if (prefix.includes('//') || prefix.includes('..')) {
    return { ok: false, message: 'pathPrefix must not contain "//" or ".."' };
  }
  if (prefix.length > 1024) {
    return { ok: false, message: 'pathPrefix is too long' };
  }
  return { ok: true, message: undefined };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Rules + this actor's grants, straight from the backend. No caching here. */
async function loadView(
  teamId: string,
  actorId: string,
  deps: SyncAclDeps,
): Promise<AclView> {
  const supabase = deps.supabase ?? createServiceRoleClient();
  const { data: rules, error: rulesErr } = await supabase
    .from('amuxc_path_acl')
    .select('id, path_prefix')
    .eq('team_id', teamId);
  if (rulesErr) throw new Error(`acl rules query failed: ${rulesErr.message}`);
  if (!rules || rules.length === 0) return EMPTY_VIEW;

  const { data: grants, error: grantsErr } = await supabase
    .from('amuxc_path_acl_grants')
    .select('acl_id')
    .eq('actor_id', actorId);
  if (grantsErr) throw new Error(`acl grants query failed: ${grantsErr.message}`);
  const granted = new Set((grants ?? []).map((g: { acl_id: string }) => g.acl_id));

  return {
    denied: (rules as { id: string; path_prefix: string }[])
      .filter((r) => !granted.has(r.id))
      .map((r) => r.path_prefix),
    allPrefixes: (rules as { path_prefix: string }[]).map((r) => r.path_prefix),
  };
}

/**
 * This caller's ACL view for this team, cached for {@link CACHE_TTL_MS}.
 *
 * ## Fail closed
 *
 * Unlike the volume guards in sync-guards.ts, a failure here is NOT waved
 * through. Those guards protect a resource, so allowing on error is the right
 * trade — a hiccup in a COUNT should not break someone's sync. This one decides
 * who may read a restricted document, and "the query failed, so show them
 * everything" is the one outcome the feature exists to prevent.
 *
 * The blast radius of failing closed is bounded and visible: sync errors for
 * everyone until the database is reachable again, which is already true of every
 * other part of this path.
 */
export async function aclViewFor(
  teamId: string,
  actorId: string,
  deps: SyncAclDeps = {},
): Promise<AclView> {
  const now = deps.nowMs?.() ?? Date.now();
  const key = `${teamId}:${actorId}`;
  const hit = viewCache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.view;

  const view = await loadView(teamId, actorId, deps);
  viewCache.set(key, { at: now, view });
  return view;
}

/** Convenience for callers that only need the deny list. */
export async function deniedPrefixesFor(
  teamId: string,
  actorId: string,
  deps: SyncAclDeps = {},
): Promise<string[]> {
  return (await aclViewFor(teamId, actorId, deps)).denied;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Record one access to restricted ground.
 *
 * Call only when `matchPrefix(path, view.allPrefixes)` matched — traffic that
 * touches nothing restricted writes no rows, which is what keeps the table
 * small enough to be worth having.
 *
 * Best effort: a failed audit write must never fail the request it describes.
 * That is a deliberate asymmetry with `aclViewFor` above — refusing access on a
 * database error protects the document, but refusing a legitimate READ because
 * the log was unavailable protects nothing and breaks sync. The error is logged
 * so a persistently failing audit is visible in the FC logs.
 */
export async function recordAccess(
  entry: {
    teamId: string;
    actorId: string;
    pathPrefix: string;
    path?: string | null;
    action: AclAction;
    allowed: boolean;
  },
  deps: SyncAclDeps = {},
): Promise<void> {
  try {
    const supabase = deps.supabase ?? createServiceRoleClient();
    const { error } = await supabase.from('amuxc_access_log').insert({
      team_id: entry.teamId,
      actor_id: entry.actorId,
      path_prefix: entry.pathPrefix,
      path: entry.path ?? null,
      action: entry.action,
      allowed: entry.allowed,
    });
    if (error) throw new Error(error.message);
  } catch (e: unknown) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        tag: 'sync-acl.audit-write-failed',
        teamId: entry.teamId,
        action: entry.action,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }
}

/**
 * Audit a single-path request, if it touched restricted ground.
 *
 * Folds the "did it match?" test and the write together so the five call sites
 * are one line each and cannot get the condition subtly different from one
 * another.
 */
export async function auditIfRestricted(
  view: AclView,
  entry: { teamId: string; actorId: string; path: string; action: AclAction; allowed: boolean },
  deps: SyncAclDeps = {},
): Promise<void> {
  if (view.allPrefixes.length === 0) return;
  const prefix = matchPrefix(entry.path, view.allPrefixes);
  if (!prefix) return;
  await recordAccess(
    {
      teamId: entry.teamId,
      actorId: entry.actorId,
      pathPrefix: prefix,
      path: entry.path,
      action: entry.action,
      allowed: entry.allowed,
    },
    deps,
  );
}

/**
 * Audit a manifest call: one row per restricted prefix this caller CAN see.
 *
 * A manifest is bulk, so per-file rows are not an option. Per-prefix answers the
 * question the audit is actually for — "before the grant was removed, who pulled
 * this directory?" — at a row count that stays trivial.
 */
export async function auditManifest(
  view: AclView,
  entry: { teamId: string; actorId: string },
  deps: SyncAclDeps = {},
): Promise<void> {
  if (view.allPrefixes.length === 0) return;
  const denied = new Set(view.denied);
  const visible = view.allPrefixes.filter((p) => !denied.has(p));
  for (const prefix of visible) {
    await recordAccess(
      {
        teamId: entry.teamId,
        actorId: entry.actorId,
        pathPrefix: prefix,
        path: null,
        action: 'manifest',
        allowed: true,
      },
      deps,
    );
  }
}

/** The 403 body every write-path rejection returns. Shape is part of the wire contract. */
export function pathForbiddenResponse(path: string) {
  return {
    statusCode: 403,
    headers: { 'Content-Type': 'application/json' },
    // The message deliberately does not name the rule or say who CAN see it:
    // the caller learns only that this path is not theirs (design D7).
    body: JSON.stringify({
      error: `path is not accessible: ${path}`,
      code: 'PathForbidden',
    }),
  };
}
