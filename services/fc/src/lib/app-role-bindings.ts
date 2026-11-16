/** Apps may admit explicitly authorized staff and collaboration identities. */
export async function appRoleBindings(
  admin: any,
  orgId: string,
  userIds: string[],
): Promise<Array<{ user_id: string; role_id: string }>> {
  const results = await Promise.all([
    admin.schema("public").from("roles_users")
      .select("user_id, role_id").eq("org_id", orgId)
      .eq("status", "active").in("user_id", userIds),
    admin.schema("amux").from("org_roles_users")
      .select("user_id, role_id").eq("org_id", orgId)
      .eq("status", "active").in("user_id", userIds),
  ]);
  for (const result of results) {
    if (result.error) throw new Error(`app role lookup failed: ${result.error.message}`);
  }
  return results.flatMap((result) => result.data ?? []);
}
