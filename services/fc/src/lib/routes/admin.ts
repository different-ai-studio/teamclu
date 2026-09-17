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
