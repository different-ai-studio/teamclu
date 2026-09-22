import { ApiError } from "../http-utils.js";
import {
  checkpointDownloadUrl,
  checkpointUpload,
  verifyCheckpointObject,
} from "../wiki-maintainer-storage.js";

export function registerWikiMaintainer(router) {
  const base = "/v1/teams/:teamId/wiki-maintainer";

  router.get(base, async (ctx) => {
    return { body: await ctx.repository.getWikiMaintainerStatus(ctx.params.teamId) };
  });

  router.put(`${base}/config`, async (ctx) => {
    return {
      body: await ctx.repository.putWikiMaintainerConfig(
        ctx.params.teamId,
        ctx.json ?? {},
      ),
    };
  });

  router.post(`${base}/checkpoints/prepare`, async (ctx) => {
    const body = ctx.json ?? {};
    const authorized = await ctx.repository.prepareWikiMaintainerCheckpoint(
      ctx.params.teamId,
      body,
    );
    const upload = await checkpointUpload({
      teamId: ctx.params.teamId,
      sha256: authorized.sha256,
      size: authorized.size,
    });
    return { body: { ...authorized, ...upload } };
  });

  router.post(`${base}/checkpoints/complete`, async (ctx) => {
    const body = ctx.json ?? {};
    await verifyCheckpointObject({
      teamId: ctx.params.teamId,
      objectKey: String(body.objectKey ?? ""),
      sha256: String(body.sha256 ?? ""),
      size: Number(body.size),
    });
    return {
      body: await ctx.repository.completeWikiMaintainerCheckpoint(
        ctx.params.teamId,
        body,
      ),
    };
  });

  router.get(`${base}/checkpoints/latest/download`, async (ctx) => {
    const checkpoint = await ctx.repository.getLatestWikiMaintainerCheckpoint(
      ctx.params.teamId,
    );
    if (!checkpoint?.objectKey) {
      throw new ApiError(404, "not_found", "wiki maintainer checkpoint not found");
    }
    return {
      body: {
        ...checkpoint,
        url: await checkpointDownloadUrl(checkpoint.objectKey),
      },
    };
  });

  router.post(`${base}/publish/begin`, async (ctx) => {
    return {
      body: await ctx.repository.beginWikiMaintainerPublish(
        ctx.params.teamId,
        ctx.json ?? {},
      ),
    };
  });

  router.post(`${base}/publish/complete`, async (ctx) => {
    return {
      body: await ctx.repository.completeWikiMaintainerPublish(
        ctx.params.teamId,
        ctx.json ?? {},
      ),
    };
  });

  router.post(`${base}/publish/recover`, async (ctx) => {
    return {
      body: await ctx.repository.recoverWikiMaintainerPublish(
        ctx.params.teamId,
        ctx.json ?? {},
      ),
    };
  });
}
