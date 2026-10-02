/**
 * Find the public.users rows carrying explicit active roles in this app org.
 * Newer rows link by auth_user_id; legacy primary rows may have id = auth uid
 * with auth_user_id null. The role's org_id, not the row's default tenant,
 * determines whether a grant applies here.
 */
export async function findAppOrgRoleIdentities(
  admin: any,
  authUserId: string,
  orgId: string,
): Promise<string[]> {
  const [linked, legacyPrimary] = await Promise.all([
    admin.schema("public").from("users").select("id")
      .eq("auth_user_id", authUserId).is("deleted_at", null),
    admin.schema("public").from("users").select("id")
      .eq("id", authUserId).is("auth_user_id", null).is("deleted_at", null),
  ]);
  if (linked.error) throw new Error(`app org identity lookup failed: ${linked.error.message}`);
  if (legacyPrimary.error) throw new Error(`app org primary identity lookup failed: ${legacyPrimary.error.message}`);

  const ids = [...new Set<string>((linked.data ?? []).concat(legacyPrimary.data ?? []).flatMap((user: any): string[] =>
    typeof user.id === "string" && user.id ? [user.id] : []))];
  if (ids.length === 0) return [];

  const { data: bindings, error: bindingsError } = await admin
    .schema("public")
    .from("roles_users")
    .select("user_id")
    .eq("org_id", orgId)
    .eq("status", "active")
    .in("user_id", ids);
  if (bindingsError) throw new Error(`app org role lookup failed: ${bindingsError.message}`);
  return [...new Set<string>((bindings ?? []).flatMap((binding: any): string[] =>
    typeof binding.user_id === "string" && binding.user_id ? [binding.user_id] : []))];
}
