/** Design: docs/specs/2026-10-14-document-library-role-access-design.md */
export function registerDocumentLibraries(router) {
  router.get("/v1/teams/:teamId/document-libraries", async (ctx) => {
    return { body: await ctx.repository.listDocumentLibraries(ctx.params.teamId) };
  });
  router.post("/v1/teams/:teamId/document-libraries/preview", async (ctx) => {
    return { body: await ctx.repository.previewDocumentLibrary(ctx.params.teamId, ctx.json ?? {}) };
  });
  router.post("/v1/teams/:teamId/document-libraries", async (ctx) => {
    const rule = await ctx.repository.createDocumentLibrary(ctx.params.teamId, ctx.json ?? {});
    return { statusCode: 201, body: rule };
  });
  router.put("/v1/teams/:teamId/document-libraries/:aclId", async (ctx) => {
    const rule = await ctx.repository.putDocumentLibrary(
      ctx.params.teamId,
      ctx.params.aclId,
      ctx.json ?? {},
    );
    return { body: rule };
  });
  router.delete("/v1/teams/:teamId/document-libraries/:aclId", async (ctx) => {
    await ctx.repository.deleteDocumentLibrary(ctx.params.teamId, ctx.params.aclId);
    return { statusCode: 204, body: null };
  });
}
