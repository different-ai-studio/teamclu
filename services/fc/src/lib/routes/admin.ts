/**
 * Platform operator surface (platform-operators.ts).
 *
 * Bearer routes like any other: the caller is a signed-in person, and the
 * repository decides whether that person is an operator. Not to be confused
 * with /v1/admin/marketplace/*, which authenticates a shared secret and has no
 * person behind it.
 */
export function registerAdmin(router) {
  // Anyone signed in may ask; the answer says whether they are an operator and
  // what their user id is. The client uses it to decide whether to show the
  // operator screens — each operator endpoint enforces on its own regardless.
  router.get("/v1/admin/whoami", async (ctx) => {
    return { body: await ctx.repository.getAdminWhoami() };
  });

  // Orgs of this deployment, and the two fields the console may change.
  router.get("/v1/admin/orgs", async (ctx) => {
    return {
      body: await ctx.repository.listAdminOrgs({
        query: ctx.query.get("query") ?? undefined,
        limit: ctx.query.get("limit") ?? undefined,
        offset: ctx.query.get("offset") ?? undefined,
      }),
    };
  });

  router.patch("/v1/admin/orgs/:orgId", async (ctx) => {
    return { body: await ctx.repository.updateAdminOrg(ctx.params.orgId, ctx.json ?? {}) };
  });

  // Teams with their balance and this month's spend. `sort=balance` puts the
  // teams about to run dry first, which is the whole point of the screen.
  router.get("/v1/admin/teams", async (ctx) => {
    return {
      body: await ctx.repository.listAdminTeams({
        query: ctx.query.get("query") ?? undefined,
        orgId: ctx.query.get("orgId") ?? undefined,
        sort: ctx.query.get("sort") ?? undefined,
        limit: ctx.query.get("limit") ?? undefined,
        offset: ctx.query.get("offset") ?? undefined,
      }),
    };
  });

  router.get("/v1/admin/teams/:teamId/credits", async (ctx) => {
    return { body: await ctx.repository.getAdminTeamCredits(ctx.params.teamId) };
  });

  router.put("/v1/admin/teams/:teamId/quotas", async (ctx) => {
    return { body: await ctx.repository.setAdminTeamQuotas(ctx.params.teamId, ctx.json ?? {}) };
  });

  // The AI gateway's provider key pools. Operators only; the repository checks.
  router.get("/v1/admin/ai/provider-pools", async (ctx) => {
    return { body: await ctx.repository.getProviderPools() };
  });

  router.post("/v1/admin/ai/provider-pools/:providerId/reset", async (ctx) => {
    return {
      body: await ctx.repository.resetProviderPool(ctx.params.providerId, ctx.json ?? {}),
    };
  });
}
