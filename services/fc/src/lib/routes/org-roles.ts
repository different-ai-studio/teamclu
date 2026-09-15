/**
 * Org-scoped role catalog routes.
 *
 * Design: docs/specs/2026-09-15-org-roles-permissions-design.md §2.1
 * Authz lives in the repository (owner/admin, system immutable, binding 409).
 */

export function registerOrgRoles(router) {
  router.get("/v1/teams/:teamId/roles", async (ctx) => {
    const items = await ctx.repository.listOrgRoles(ctx.params.teamId);
    return { body: { items } };
  });

  router.post("/v1/teams/:teamId/roles", async (ctx) => {
    const row = await ctx.repository.createOrgRole(ctx.params.teamId, ctx.json ?? {});
    return { statusCode: 201, body: row };
  });

  router.patch("/v1/teams/:teamId/roles/:roleId", async (ctx) => {
    const row = await ctx.repository.patchOrgRole(
      ctx.params.teamId,
      ctx.params.roleId,
      ctx.json ?? {},
    );
    return { body: row };
  });

  router.delete("/v1/teams/:teamId/roles/:roleId", async (ctx) => {
    await ctx.repository.deleteOrgRole(ctx.params.teamId, ctx.params.roleId);
    return { statusCode: 204, body: null };
  });
}
