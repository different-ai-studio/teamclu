/**
 * Knowledge path ACL management routes.
 *
 * Design: docs/specs/2026-08-31-knowledge-path-acl-design.md
 *
 * Owner/admin only — the check lives in the repository, not here, so both
 * backends enforce it identically.
 *
 * These routes manage the RULES. Enforcement happens on `/sync/*` via
 * lib/sync-acl.ts, and a client never learns which prefixes are restricted: a
 * directory it cannot see is absent, not locked (design D7).
 */
export function registerKnowledgeAcl(router) {
  router.get("/v1/teams/:teamId/knowledge-acl", async (ctx) => {
    return { body: await ctx.repository.listKnowledgeAcl(ctx.params.teamId) };
  });

  /**
   * Dry run. Answers "how much would this restriction take away?" without
   * writing anything, so the confirmation screen can show the number BEFORE the
   * admin commits to it.
   *
   * Registered before the `:aclId` routes so "preview" is not read as an id.
   */
  router.post("/v1/teams/:teamId/knowledge-acl/preview", async (ctx) => {
    return { body: await ctx.repository.previewKnowledgeAcl(ctx.params.teamId, ctx.json ?? {}) };
  });

  /**
   * Create a rule.
   *
   * Restricting a directory that already holds files removes them from every
   * unlisted member's disk, so this returns 409 `confirmation_required` (with
   * the affected counts in `details`) unless the body carries
   * `confirmRevokeExisting: true`.
   */
  router.post("/v1/teams/:teamId/knowledge-acl", async (ctx) => {
    const rule = await ctx.repository.createKnowledgeAcl(ctx.params.teamId, ctx.json ?? {});
    return { statusCode: 201, body: rule };
  });

  router.patch("/v1/teams/:teamId/knowledge-acl/:aclId", async (ctx) => {
    const rule = await ctx.repository.updateKnowledgeAcl(
      ctx.params.teamId,
      ctx.params.aclId,
      ctx.json ?? {},
    );
    return { body: rule };
  });

  router.delete("/v1/teams/:teamId/knowledge-acl/:aclId", async (ctx) => {
    await ctx.repository.deleteKnowledgeAcl(ctx.params.teamId, ctx.params.aclId);
    return { statusCode: 204, body: null };
  });
}
