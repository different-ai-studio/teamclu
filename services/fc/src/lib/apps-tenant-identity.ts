/**
 * Which account a signed-in visitor should be inside one app's org.
 *
 * One person, one identity per org, and each identity is its own auth account
 * (docs/plans/2026-10-08-staff-only-identity-model.md). The gateway admits by
 * `public.users.auth_user_id = <session sub>` in the app's org
 * (apps-org-role-identity.ts), so a session has to be for the identity that
 * lives THERE. Phone login already signs in per tenant; email / password /
 * OAuth sign in as "the account with this email", and the SSO cookie carries
 * whichever account the previous app used. Both can name the right person but
 * the wrong identity — an email user's identity in an org they were invited to
 * sits on a synthetic `<id>@teamclu.email` account.
 *
 * This resolves the person (same mobile, or linked through
 * public.email_users_links) to their identity in the org. It never invents an
 * identity: `inOrg: false` means this person has none there.
 */
export type TenantVisitor = { sub: string; email: string };
export type TenantIdentity = { user: TenantVisitor; inOrg: boolean };

export async function findTenantIdentity(
  admin: any,
  visitor: TenantVisitor,
  orgId: string,
): Promise<TenantIdentity> {
  const users = () => admin.schema("public").from("users");

  // Already an identity there: keep the session as it is.
  const { data: own, error: ownErr } = await users()
    .select("id")
    .eq("org_id", orgId)
    .eq("auth_user_id", visitor.sub)
    .is("deleted_at", null)
    .limit(1);
  if (ownErr) throw new Error(`tenant identity lookup failed: ${ownErr.message}`);
  if ((own ?? []).length > 0) return { user: visitor, inOrg: true };

  // The person behind this account: its rows' phones and linked emails.
  const { data: mine, error: mineErr } = await users()
    .select("id, mobile")
    .eq("auth_user_id", visitor.sub)
    .is("deleted_at", null);
  if (mineErr) throw new Error(`tenant identity lookup failed: ${mineErr.message}`);
  const mobiles = [...new Set((mine ?? []).map((r: any) => (r.mobile ?? "").trim()).filter(Boolean))];

  const emails = new Set<string>();
  if (visitor.email) emails.add(visitor.email.trim().toLowerCase());
  const myIds = (mine ?? []).map((r: any) => r.id).filter(Boolean);
  if (myIds.length > 0) {
    const { data: links, error } = await admin.schema("public").from("email_users_links")
      .select("email").in("user_id", myIds);
    if (error) throw new Error(`email link lookup failed: ${error.message}`);
    for (const l of links ?? []) if (l.email) emails.add(String(l.email));
  }
  let linkedIds: string[] = [];
  if (emails.size > 0) {
    const { data: links, error } = await admin.schema("public").from("email_users_links")
      .select("user_id").in("email", [...emails]);
    if (error) throw new Error(`email link lookup failed: ${error.message}`);
    linkedIds = (links ?? []).map((l: any) => l.user_id).filter(Boolean);
  }

  const candidates: any[] = [];
  if (linkedIds.length > 0) {
    const { data, error } = await users()
      .select("id, auth_user_id, admin_type, created_at")
      .eq("org_id", orgId).in("id", linkedIds).is("deleted_at", null);
    if (error) throw new Error(`tenant identity lookup failed: ${error.message}`);
    candidates.push(...(data ?? []));
  }
  if (mobiles.length > 0) {
    const { data, error } = await users()
      .select("id, auth_user_id, admin_type, created_at")
      .eq("org_id", orgId).in("mobile", mobiles).is("deleted_at", null);
    if (error) throw new Error(`tenant identity lookup failed: ${error.message}`);
    candidates.push(...(data ?? []));
  }

  // Only rows that are an account of their own can be signed in as. Staff
  // first (the identity TeamClu and the back office act as), then the oldest.
  const pick = candidates
    .filter((r) => typeof r.auth_user_id === "string" && r.auth_user_id)
    .sort((a, b) =>
      Number(b.admin_type ?? 0) - Number(a.admin_type ?? 0) ||
      String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))[0];
  if (!pick) return { user: visitor, inOrg: false };
  return { user: { sub: pick.auth_user_id, email: visitor.email }, inOrg: true };
}
