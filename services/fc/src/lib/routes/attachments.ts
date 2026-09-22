import { ApiError } from "../http-utils.js";

const ALLOWED_BUCKETS = new Set(["attachments", "avatars"]);
const DEFAULT_BUCKET = "attachments";

const THUMBNAIL_QUALITY = 70;
const MIN_THUMBNAIL_WIDTH = 32;
// Wider than any phone screen. Past this there is nothing to gain over
// fetching the object itself.
const MAX_THUMBNAIL_WIDTH = 1600;
const DEFAULT_THUMBNAIL_WIDTH = 600;

function parseWidth(value) {
  if (value === null || value === undefined || value === "") return DEFAULT_THUMBNAIL_WIDTH;
  const width = Number(value);
  if (!Number.isInteger(width) || width < MIN_THUMBNAIL_WIDTH || width > MAX_THUMBNAIL_WIDTH) {
    throw new ApiError(
      400,
      "validation_failed",
      `width must be an integer from ${MIN_THUMBNAIL_WIDTH} to ${MAX_THUMBNAIL_WIDTH}`,
    );
  }
  return width;
}

function resolveBucket(value) {
  if (value === null || value === undefined || value === "") return DEFAULT_BUCKET;
  if (!ALLOWED_BUCKETS.has(value)) {
    throw new ApiError(400, "invalid_request", `unsupported bucket: ${value}`);
  }
  return value;
}

export function registerAttachments(router) {
  router.postRaw("/v1/attachments", async (ctx) => {
    const path = ctx.query.get("path");
    if (!path) throw new ApiError(400, "invalid_request", "path query parameter is required");
    const bucket = resolveBucket(ctx.query.get("bucket"));
    const mime = ctx.headers["content-type"] ?? "application/octet-stream";
    const out = await ctx.repository.uploadAttachment({ path, mime, bytes: ctx.rawBody, bucket });
    return { statusCode: 200, body: out };
  });

  // Declared before the `:path` route so "thumbnail" is not read as a path.
  //
  // Takes a bucket and an object path rather than a URL. A URL parameter would
  // make this a fetcher for anything the network can reach; a path can only
  // name something in a bucket this service already serves.
  router.get("/v1/attachments/thumbnail", async (ctx) => {
    const path = ctx.query.get("path");
    if (!path) throw new ApiError(400, "invalid_request", "path query parameter is required");
    const bucket = resolveBucket(ctx.query.get("bucket"));
    const width = parseWidth(ctx.query.get("width"));
    const out = await ctx.repository.downloadAttachmentThumbnail(path, {
      bucket,
      width,
      quality: THUMBNAIL_QUALITY,
    });
    if (!out) throw new ApiError(404, "not_found", "attachment not found");
    return {
      binary: { mime: out.mime, bytes: out.bytes },
      // The bytes for a given path and width never change — a new picture is
      // a new path — so this is worth caching hard at every hop.
      headers: { "Cache-Control": "public, max-age=31536000, immutable" },
    };
  });

  router.get("/v1/attachments/:path", async (ctx) => {
    const bucket = resolveBucket(ctx.query.get("bucket"));
    const out = await ctx.repository.downloadAttachment(ctx.params.path, { bucket });
    if (!out) throw new ApiError(404, "not_found", "attachment not found");
    return { binary: { mime: out.mime, bytes: out.bytes } };
  });
}
