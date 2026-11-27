/**
 * Writes to amux.app_grants — who, beyond its creator, reaches an app: an
 * account at a level, or an org (read). P3.2 of
 * docs/specs/2026-11-26-app-platform-p3-retire-legacy.md.
 *
 * Until P3.4 the product also writes its legacy rows and P2.1's triggers
 * project them here first, so each write is idempotent: it settles the row
 * to the wanted state whether or not the projection already did. The unique
 * indexes are partial (`where principal_… is not null`), which PostgREST's
 * upsert cannot target, so a set is update-then-insert and a duplicate on
 * insert means someone else just wrote the same row.
 *
 * `admin` is a service-role client: callers authorize first.
 */
import type { AppPermissionLevel } from "../app-permission.js";

const UNIQUE_VIOLATION = "23505";

/** The account's current level on the app, or null. */
export async function readUserGrantLevel(admin: any, appId: string, userId: string): Promise<string | null> {
  const { data, error } = await admin
    .from("app_grants")
    .select("level")
    .eq("app_id", appId)
    .eq("principal_user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data?.level ?? null;
}

export async function setUserGrant(
  admin: any,
  grant: { appId: string; userId: string; level: AppPermissionLevel; grantedByUserId: string | null },
): Promise<void> {
  const now = new Date().toISOString();
  const { data: updated, error: updErr } = await admin
    .from("app_grants")
    .update({ level: grant.level, granted_by_user_id: grant.grantedByUserId, updated_at: now })
    .eq("app_id", grant.appId)
    .eq("principal_user_id", grant.userId)
    .select("id");
  if (updErr) throw updErr;
  if ((updated ?? []).length > 0) return;
  const { error: insErr } = await admin.from("app_grants").insert({
    app_id: grant.appId,
    principal_user_id: grant.userId,
    level: grant.level,
    granted_by_user_id: grant.grantedByUserId,
  });
  if (insErr && insErr.code !== UNIQUE_VIOLATION) throw insErr;
}

export async function removeUserGrant(admin: any, appId: string, userId: string): Promise<void> {
  const { error } = await admin.from("app_grants").delete().eq("app_id", appId).eq("principal_user_id", userId);
  if (error) throw error;
}

/** Whether `orgId`'s members see the app (read). Off removes every org grant on it. */
export async function setOrgGrant(admin: any, appId: string, orgId: string, on: boolean): Promise<void> {
  if (!on) {
    const { error } = await admin.from("app_grants").delete().eq("app_id", appId).not("principal_org_id", "is", null);
    if (error) throw error;
    return;
  }
  const { error } = await admin.from("app_grants").insert({ app_id: appId, principal_org_id: orgId, level: "read" });
  if (error && error.code !== UNIQUE_VIOLATION) throw error;
}
