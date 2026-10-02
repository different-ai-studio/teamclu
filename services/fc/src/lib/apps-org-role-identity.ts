/**
 * Find the public.users row carrying an explicit active role in this app org.
 * Team membership can attach a role to the account's primary row even when
 * that row belongs to another tenant. The role's org_id, not the user's
 * default tenant, determines whether that grant applies here.
 */
export async function findAppOrgRoleIdentities(
  admin: any,
  authUserId: string,
  orgId: string,
): Promise<string[]> {
  const { data: users, error: usersError } = await admin
    .schema("public")
    .from("users")
    .select("id")
    .eq("auth_user_id", authUserId)
    .is("deleted_at", null);
  if (usersError) throw new Error(`app org identity lookup failed: ${usersError.message}`);

  const ids = [...new Set<string>((users ?? []).flatMap((user: any): string[] =>
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
