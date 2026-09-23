import { ApiError } from "../http-utils.js";
import { getTeamBlobStorage } from "../team-blob-storage.js";
import {
  checkpointDownloadUrl,
  checkpointUpload,
  verifyCheckpointObject,
} from "../wiki-maintainer-storage.js";

async function removeCheckpointObjects(objectKeys: string[]) {
  const storage = getTeamBlobStorage();
  for (const objectKey of objectKeys) {
    await storage.remove(objectKey);
  }
}

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
    await ctx.repository.recordWikiMaintainerUpload(ctx.params.teamId, upload.objectKey);
    await removeCheckpointObjects(
      await ctx.repository.sweepWikiMaintainerUploads(ctx.params.teamId),
    );
    return { body: { ...authorized, ...upload } };
  });

  router.post(`${base}/checkpoints/complete`, async (ctx) => {
    const body = ctx.json ?? {};
    // Reject non-admin and stale CAS requests before fetching a potentially
    // large object from private storage. The completion RPC repeats the CAS
    // check under its row lock after byte verification.
    await ctx.repository.prepareWikiMaintainerCheckpoint(ctx.params.teamId, body);
    const manifest = await verifyCheckpointObject({
      teamId: ctx.params.teamId,
      objectKey: String(body.objectKey ?? ""),
      sha256: String(body.sha256 ?? ""),
      size: Number(body.size),
    });
    const completed = await ctx.repository.completeWikiMaintainerCheckpoint(
      ctx.params.teamId,
      { ...body, manifest },
    );
    await removeCheckpointObjects([
      ...(await ctx.repository.pruneWikiMaintainerCheckpoints(ctx.params.teamId)),
      ...(await ctx.repository.sweepWikiMaintainerUploads(ctx.params.teamId)),
    ]);
    return { body: completed };
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

  router.get(`${base}/checkpoints/:generation/download`, async (ctx) => {
    const generation = Number(ctx.params.generation);
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new ApiError(400, "validation_failed", "checkpoint generation is invalid");
    }
    const checkpoint = await ctx.repository.getWikiMaintainerCheckpointByGeneration(
      ctx.params.teamId,
      generation,
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
