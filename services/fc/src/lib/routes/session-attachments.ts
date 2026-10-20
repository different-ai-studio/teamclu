import {
  parseLimit,
  decodeSessionAttachmentCursor,
  nextSessionAttachmentCursor,
} from "../routing-utils.js";

export function registerSessionAttachments(router) {
  router.get("/v1/sessions/:sessionId/attachments", async (ctx) => {
    const limit = parseLimit(ctx.query.get("limit"));
    const cursor = decodeSessionAttachmentCursor(ctx.query.get("cursor"));
    const sessionId = decodeURIComponent(ctx.params.sessionId);
    const page = await ctx.repository.listSessionAttachments(sessionId, { limit, cursor });
    return {
      body: {
        items: page.items,
        nextCursor: page.nextCursor ?? nextSessionAttachmentCursor(page.items, limit),
      },
    };
  });
}
