// services/fc/src/lib/sync-auth.ts
//
// JWT verification + actor resolution for /sync/* endpoints.
// Spec §3 auth middleware.
//
// The caller's GoTrue JWT is verified with supabase.auth.getUser, and their
// actor for the team comes from the amux.actor_id_for_user_in_team RPC.

import { createServiceRoleClient } from './supabase.js';

// ---------------------------------------------------------------------------
// extractBearer — shared helper
// Returns null on success (token string), or an error object on failure.
// Avoids discriminated-union narrowing issues under strict:false.
// ---------------------------------------------------------------------------

function extractBearer(
  headers: Record<string, string> | undefined,
): { token: string; err: null } | { token: null; err: { status: 401; error: string } } {
  const authz = headers?.authorization || headers?.Authorization;
  if (!authz?.startsWith('Bearer ')) {
    return { token: null, err: { status: 401, error: 'missing bearer token' } };
  }
  return { token: authz.slice(7), err: null };
}

// ---------------------------------------------------------------------------
// authenticateJwtOnly
// ---------------------------------------------------------------------------

/**
 * Verify the Bearer JWT without checking team membership.
 * Used for /sync/create-team where the team does not exist yet.
 *
 * Returns:
 *   { ok: true,  userId }
 *   { ok: false, status: 401, error: string }
 */
export async function authenticateJwtOnly(
  { headers }: { headers: Record<string, string> | undefined },
): Promise<{ ok: true; userId: string } | { ok: false; status: number; error: string }> {
  const { token, err: bearerErr } = extractBearer(headers);
  if (bearerErr) return { ok: false, ...bearerErr };
  if (!token) return { ok: false, status: 401, error: 'missing bearer token' };

  const supabase = createServiceRoleClient();
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user?.id) {
    return { ok: false, status: 401, error: `jwt invalid: ${userErr?.message ?? 'no user'}` };
  }
  return { ok: true, userId: userData.user.id };
}

// ---------------------------------------------------------------------------
// authenticateSyncCall
// ---------------------------------------------------------------------------

/**
 * Verify the Supabase Bearer JWT and resolve the caller's actor_id for the
 * given team.
 *
 * Returns:
 *   { ok: true,  userId, teamId, actorId }
 *   { ok: false, status: 401|403, error: string }
 */
export async function authenticateSyncCall(
  { headers, teamId }: { headers: Record<string, string> | undefined; teamId: string },
): Promise<
  | { ok: true; userId: string; teamId: string; actorId: string }
  | { ok: false; status: number; error: string }
> {
  const { token, err: bearerErr } = extractBearer(headers);
  if (bearerErr) return { ok: false, ...bearerErr };
  if (!token) return { ok: false, status: 401, error: 'missing bearer token' };

  const supabase = createServiceRoleClient();
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user?.id) {
    return { ok: false, status: 401, error: `jwt invalid: ${userErr?.message ?? 'no user'}` };
  }
  const userId = userData.user.id;

  const { data: rows, error } = await supabase
    .schema("amux").rpc('actor_id_for_user_in_team', { p_user_id: userId, p_team_id: teamId });

  if (error) {
    return { ok: false, status: 403, error: `actor lookup failed: ${error.message}` };
  }
  if (rows == null || (Array.isArray(rows) && rows.length === 0)) {
    return { ok: false, status: 403, error: 'caller is not a member of this team' };
  }

  // actor_id_for_user_in_team `returns uuid` (a scalar), so supabase-js returns
  // the uuid STRING directly in `data` — NOT wrapped in an array/object. The
  // old `rows[0]` indexed the first CHARACTER of that string (e.g. "f"), which
  // then got inserted into a uuid column and failed upload-prepare with
  // "invalid input syntax for type uuid". Normalize all possible shapes.
  let actorId: string | null = null;
  if (typeof rows === 'string') {
    actorId = rows;
  } else if (Array.isArray(rows)) {
    const first = rows[0];
    actorId = first && typeof first === 'object' ? (Object.values(first)[0] as string) : first;
  } else if (typeof rows === 'object') {
    actorId = Object.values(rows as object)[0] as string;
  }
  if (!actorId || typeof actorId !== 'string') {
    return { ok: false, status: 403, error: 'caller has no actor in this team' };
  }

  return { ok: true, userId, teamId, actorId };
}
