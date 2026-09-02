import { ApiError } from "../http-utils.js";

/**
 * Team skills registry routes.
 *
 * Design: docs/architecture/team-skills-registry.md
 *
 * The zip itself never travels through these handlers. Publishing is two steps:
 * the client uploads the package via the existing amuxc blob path and then
 * posts the resulting contentHash here. That keeps big bodies off the business
 * API and reuses the blob dedupe we already have.
 */
export function registerTeamSkills(router) {
  // Full registry. `actorId` picks whose install state decorates the rows —
  // omit it for "me", pass a team agent's actor id to inspect that agent.
  router.get("/v1/teams/:teamId/skills", async (ctx) => {
    const opts: any = {};
    const actorId = ctx.query.get("actorId");
    if (actorId) opts.actorId = actorId;
    const status = ctx.query.get("status");
    if (status) opts.status = status;
    const category = ctx.query.get("category");
    if (category) opts.category = category;
    const items = await ctx.repository.listTeamSkills(ctx.params.teamId, opts);
    return { body: { items } };
  });

  // What a given actor should have installed. The daemon hosting a team agent
  // polls this and reconciles the full set.
  router.get("/v1/teams/:teamId/skill-installs", async (ctx) => {
    const opts: any = {};
    const actorId = ctx.query.get("actorId");
    if (actorId) opts.actorId = actorId;
    const items = await ctx.repository.listTeamSkillInstalls(ctx.params.teamId, opts);
    return { body: { items } };
  });

  router.get("/v1/teams/:teamId/skills/:slug", async (ctx) => {
    const opts: any = {};
    const actorId = ctx.query.get("actorId");
    if (actorId) opts.actorId = actorId;
    const skill = await ctx.repository.getTeamSkill(ctx.params.teamId, ctx.params.slug, opts);
    return { body: skill };
  });

  router.post("/v1/teams/:teamId/skills", async (ctx) => {
    const skill = await ctx.repository.createTeamSkill(ctx.params.teamId, ctx.json ?? {});
    return { statusCode: 201, body: skill };
  });

  // Content-addressed package upload (amuxc_blobs), without an amuxc_files path.
  // Client: prepare → optional PUT → complete → POST /skills with contentHash.
  router.post("/v1/teams/:teamId/skill-blobs/prepare", async (ctx) => {
    const prepared = await ctx.repository.prepareTeamSkillBlob(
      ctx.params.teamId,
      ctx.json ?? {},
    );
    let presignedPut: string | null = null;
    if (!prepared.verified) {
      const { createSkillUploadUrl } = await import("../skills-storage.js");
      presignedPut = await createSkillUploadUrl(prepared.ossKey);
    }
    return {
      body: {
        contentHash: prepared.contentHash,
        size: prepared.size,
        ossKey: prepared.ossKey,
        requiresUpload: !prepared.verified,
        presignedPut,
      },
    };
  });

  router.post("/v1/teams/:teamId/skill-blobs/complete", async (ctx) => {
    const body = ctx.json ?? {};
    const contentHash = String(body.contentHash ?? "").trim().toLowerCase();
    // Re-resolve placeholder so we know expected size before checking storage.
    const prepared = await ctx.repository.prepareTeamSkillBlob(ctx.params.teamId, body);
    const { verifySkillPackageObject } = await import("../skills-storage.js");
    await verifySkillPackageObject(prepared.ossKey, {
      contentHash,
      size: prepared.size,
    });
    const done = await ctx.repository.completeTeamSkillBlob(ctx.params.teamId, {
      contentHash,
      size: prepared.size,
    });
    return { body: done };
  });

  router.post("/v1/teams/:teamId/skills/:slug/versions", async (ctx) => {
    const version = await ctx.repository.createTeamSkillVersion(
      ctx.params.teamId,
      ctx.params.slug,
      ctx.json ?? {},
    );
    return { statusCode: 201, body: version };
  });

  // Undo for a bad publish. Rolls forward with the old content rather than
  // moving latest_version back — see the repository implementation.
  router.post("/v1/teams/:teamId/skills/:slug/versions/:version/revert", async (ctx) => {
    const version = Number(ctx.params.version);
    if (!Number.isInteger(version) || version < 1) {
      throw new ApiError(400, "validation_failed", "version must be a positive integer");
    }
    const created = await ctx.repository.revertTeamSkillVersion(
      ctx.params.teamId,
      ctx.params.slug,
      version,
      ctx.json ?? {},
    );
    return { statusCode: 201, body: created };
  });

  router.get("/v1/teams/:teamId/skills/:slug/versions/:version", async (ctx) => {
    const version = Number(ctx.params.version);
    if (!Number.isInteger(version) || version < 1) {
      throw new ApiError(400, "validation_failed", "version must be a positive integer");
    }
    const row = await ctx.repository.getTeamSkillVersion(
      ctx.params.teamId,
      ctx.params.slug,
      version,
    );
    return { body: row };
  });

  // Hands back a short-lived signed URL rather than proxying the bytes: the
  // package can be megabytes and the business API is not the place for that.
  router.get("/v1/teams/:teamId/skills/:slug/versions/:version/download", async (ctx) => {
    const version = Number(ctx.params.version);
    if (!Number.isInteger(version) || version < 1) {
      throw new ApiError(400, "validation_failed", "version must be a positive integer");
    }
    const blob = await ctx.repository.getTeamSkillDownload(
      ctx.params.teamId,
      ctx.params.slug,
      version,
    );
    const { createSkillDownloadUrl } = await import("../skills-storage.js");
    const url = await createSkillDownloadUrl(blob.ossKey);
    return { body: { url, contentHash: blob.contentHash, size: blob.size } };
  });

  router.patch("/v1/teams/:teamId/skills/:slug", async (ctx) => {
    const skill = await ctx.repository.updateTeamSkill(
      ctx.params.teamId,
      ctx.params.slug,
      ctx.json ?? {},
    );
    return { body: skill };
  });

  router.delete("/v1/teams/:teamId/skills/:slug", async (ctx) => {
    await ctx.repository.deleteTeamSkill(ctx.params.teamId, ctx.params.slug);
    return { statusCode: 204, body: null };
  });

  router.put("/v1/teams/:teamId/skills/:slug/install", async (ctx) => {
    const install = await ctx.repository.installTeamSkill(
      ctx.params.teamId,
      ctx.params.slug,
      ctx.json ?? {},
    );
    return { body: install };
  });

  router.delete("/v1/teams/:teamId/skills/:slug/install", async (ctx) => {
    // DELETE bodies are legal but awkward for some clients, so the target actor
    // can also arrive as a query param.
    const body: any = ctx.json ?? {};
    const actorId = ctx.query.get("actorId");
    if (actorId && body.actorId === undefined) body.actorId = actorId;
    await ctx.repository.uninstallTeamSkill(ctx.params.teamId, ctx.params.slug, body);
    return { statusCode: 204, body: null };
  });
}
