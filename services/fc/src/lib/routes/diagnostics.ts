import { ApiError } from "../http-utils.js";
import { isRateLimited } from "../rate-limit.js";
import { diagnosticStorage, downloadDiagnostic, uploadDiagnostic, MAX_DIAGNOSTIC_BYTES } from "../diagnostic-storage.js";

export function registerDiagnostics(router, storage = diagnosticStorage) {
  router.postRaw("/v1/diagnostics", { maxBodyBytes: MAX_DIAGNOSTIC_BYTES, noStore: true }, async (ctx) => {
    // getAdminWhoami verifies the caller with getCurrentUser (including partner sessions).
    // Never trust a user/team id supplied in a header or upload body.
    const caller = await ctx.repository.getAdminWhoami();
    if (!caller?.userId) throw new ApiError(401, "missing_auth", "Authenticated user required");
    if (isRateLimited(`diagnostic-upload:${caller.userId}`, 3)) {
      throw new ApiError(429, "rate_limited", "Too many diagnostic uploads. Please try again in a minute.");
    }
    try {
      return {
        statusCode: 201, headers: { "Cache-Control": "no-store" },
        body: await uploadDiagnostic(caller.userId, ctx.rawBody, ctx.getHeader("content-type"), storage()),
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // Storage errors can include bucket/host/signature details. Do not leak them to clients.
      throw new ApiError(502, "diagnostic_upload_failed", "Diagnostic upload failed. Please retry or export the ZIP locally.");
    }
  });
  router.get("/v1/diagnostics/:receiptId", { noStore: true }, async (ctx) => {
    const caller = await ctx.repository.getAdminWhoami();
    if (!caller?.userId) throw new ApiError(401, "missing_auth", "Authenticated user required");
    try {
      return {
        headers: { "Cache-Control": "no-store" },
        body: await downloadDiagnostic(ctx.params.receiptId, caller, storage()),
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, "diagnostic_download_failed", "Diagnostic download is temporarily unavailable.");
    }
  });
}
