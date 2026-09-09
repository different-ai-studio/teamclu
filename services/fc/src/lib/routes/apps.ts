import { ApiError } from "../http-utils.js";
import { parseLimit, requireString } from "../routing-utils.js";
import { runDueAppCronJobs } from "../app-cron-runner.js";
import { createServiceRoleClient } from "../supabase.js";

/**
 * Object paths travel as base64url, the same trick the data browser plays with
 * `:rowKey` (see the note above those routes): a file path contains slashes,
 * and a slash cannot survive a single path segment. Encoding it keeps one
 * route shape for `a.txt` and for `reports/2026/q3.csv`.
 */
function decodeFilePath(raw: string): string {
  let decoded: string;
  try {
    decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    throw new ApiError(400, "validation_failed", "file path is not valid base64url");
  }
  if (!decoded) throw new ApiError(400, "validation_failed", "file path is empty");
  return decoded;
}

/**
 * Drop credentials out of a repo URL before it is stored.
 *
 * `https://x:ghp_…@github.com/owner/repo.git` is a working git address and the
 * obvious way to import a private repo, so people paste it. What they do not
 * expect is that it lands in `apps.git_remote_url` — a column `GET /v1/apps/:id`
 * hands to every member who can see the app, and which nothing ever redacts.
 * One paste turns a personal access token into team-readable data.
 *
 * The credential still reaches the clone: the desktop sends the address the
 * user typed straight to its local daemon for that one call. What stops here is
 * the copy that would outlive it.
 *
 * Scheme decides how much goes:
 * - **http(s)** — the whole userinfo. Nothing there is an address; an anonymous
 *   clone needs none of it, and every form GitHub documents (`token@`,
 *   `user:token@`) is a secret.
 * - **ssh / git** — the password half only. `git@` IS the address for those,
 *   and dropping it produces a URL that cannot connect.
 * - **scp-like `git@host:path`** — untouched, for the same reason.
 */
export function stripUrlCredentials(url: string): string {
  const schemeEnd = url.indexOf("://");
  if (schemeEnd < 0) return url;
  const scheme = url.slice(0, schemeEnd);
  const rest = url.slice(schemeEnd + 3);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd < 0 ? rest : rest.slice(0, authorityEnd);
  const tail = authorityEnd < 0 ? "" : rest.slice(authorityEnd);
  // Last `@`, not the first: a password is supposed to percent-encode one, and
  // a lenient split on the first would cut a host off a sloppy-but-working URL.
  const at = authority.lastIndexOf("@");
  if (at < 0) return url;
  const userinfo = authority.slice(0, at);
  const host = authority.slice(at + 1);
  const lower = scheme.toLowerCase();
  const keep = lower === "ssh" || lower === "git" ? userinfo.split(":")[0] : "";
  return `${scheme}://${keep ? `${keep}@` : ""}${host}${tail}`;
}

/**
 * Normalize the optional repo URL an app is imported from.
 *
 * The daemon validates it again before handing it to `git clone` — that check
 * is the security boundary, since it is the one next to the process spawn. This
 * one exists so a typo is a 400 at create time instead of a row that can never
 * be seeded. Same allowlist: http(s) / ssh / git://, or scp-like `git@host:path`.
 *
 * Credentials are stripped here rather than rejected: refusing the paste would
 * be a dead end for a private repo on a machine with no credential helper, and
 * the address is still perfectly usable without them.
 */
function normalizeGitRemoteUrl(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new ApiError(400, "validation_failed", "gitRemoteUrl must be a string");
  }
  const url = raw.trim();
  if (!url) return null;
  const schemed = /^(https?|ssh|git):\/\/[^\s]+$/.test(url);
  const scpLike = /^[^\s:/@]+@[^\s:/@]+:[^\s]+$/.test(url);
  if (!schemed && !scpLike) {
    throw new ApiError(
      400,
      "validation_failed",
      "gitRemoteUrl must be an http(s), ssh or git:// address",
    );
  }
  return stripUrlCredentials(url);
}

export function registerApps(router) {
  router.get("/v1/apps", async (ctx) => {
    const teamId = ctx.query.get("teamId");
    requireString(teamId, "teamId");
    const limit = parseLimit(ctx.query.get("limit"));
    const items = await ctx.repository.listApps({ teamId, limit });
    return { body: { items } };
  });

  router.post("/v1/apps", async (ctx) => {
    const body = ctx.json ?? {};
    requireString(body.teamId, "teamId");
    requireString(body.name, "name");
    requireString(body.type, "type");
    const out = await ctx.repository.createApp({
      ...body,
      gitRemoteUrl: normalizeGitRemoteUrl(body.gitRemoteUrl),
    });
    return { statusCode: 201, body: out };
  });

  router.get("/v1/apps/:appId", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const out = await ctx.repository.getApp(appId);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  router.patch("/v1/apps/:appId", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const body = ctx.json ?? {};
    const out = await ctx.repository.updateApp(appId, body);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  router.delete("/v1/apps/:appId", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const ok = await ctx.repository.deleteApp(appId);
    if (!ok) throw new ApiError(404, "not_found", "app not found");
    return { body: { ok: true } };
  });

  router.post("/v1/apps/:appId/deploy", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const body = ctx.json ?? {};
    const out = await ctx.repository.deployApp(appId, body);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { statusCode: 202, body: out };
  });

  router.post("/v1/apps/:appId/deploy/finalize", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const body = ctx.json ?? {};
    const out = await ctx.repository.finalizeDeploy(appId, body);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  router.get("/v1/apps/:appId/sessions", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const items = await ctx.repository.listAppSessions(appId);
    return { body: { items } };
  });

  // Secret response — never log the body (private deploy key).
  router.get("/v1/apps/:appId/git-credential", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const out = await ctx.repository.getAppGitCredential(appId);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  // Handing a key back the moment ssh exits — see `amuxd git-ssh`. Idempotent:
  // a key already gone answers 200 with `revoked: false`, because "not usable
  // any more" is what the caller asked for either way.
  router.delete("/v1/apps/:appId/git-credential/:deployKeyId", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const deployKeyId = Number.parseInt(decodeURIComponent(ctx.params.deployKeyId), 10);
    if (!Number.isInteger(deployKeyId)) {
      throw new ApiError(400, "bad_request", "deployKeyId must be an integer");
    }
    const out = await ctx.repository.revokeAppGitCredential(appId, deployKeyId);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  // The deployed function's own output. Read-only and scoped to one app by the
  // repository, which names the function from the app row — the caller never
  // gets to say which function's logs it wants.
  router.get("/v1/apps/:appId/logs", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const out = await ctx.repository.getAppLogs(appId, {
      sinceMinutes: ctx.query.get("sinceMinutes"),
      limit: ctx.query.get("limit"),
      kind: ctx.query.get("kind"),
      contains: ctx.query.get("contains"),
      requestId: ctx.query.get("requestId"),
    });
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  router.get("/v1/apps/:appId/git-head", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const out = await ctx.repository.getAppGitHead(appId);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  // --- App data browser (design 2026-08-27-app-data-browser) ---
  //
  // `:table` and `:rowKey` are never interpolated into SQL by the repo: the
  // table is looked up in the app schema's information_schema first and the
  // statement is built from the catalog's own strings. `:rowKey` is the opaque
  // base64url form of the row's primary-key values, which is what lets a
  // composite key (and a value containing a slash) survive a path segment.

  router.get("/v1/apps/:appId/data/tables", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const out = await ctx.repository.listAppDataTables(appId);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  router.get("/v1/apps/:appId/data/tables/:table/rows", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const table = decodeURIComponent(ctx.params.table);
    const out = await ctx.repository.readAppDataRows(appId, table, {
      after: ctx.query.get("after"),
      direction: ctx.query.get("direction"),
      limit: ctx.query.get("limit"),
      filterColumn: ctx.query.get("filterColumn"),
      filterOp: ctx.query.get("filterOp"),
      filterValue: ctx.query.get("filterValue"),
    });
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  router.patch("/v1/apps/:appId/data/tables/:table/rows/:rowKey", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const table = decodeURIComponent(ctx.params.table);
    const rowKey = decodeURIComponent(ctx.params.rowKey);
    const out = await ctx.repository.updateAppDataRow(appId, table, rowKey, ctx.json ?? {});
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  router.delete("/v1/apps/:appId/data/tables/:table/rows/:rowKey", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const table = decodeURIComponent(ctx.params.table);
    const rowKey = decodeURIComponent(ctx.params.rowKey);
    const out = await ctx.repository.deleteAppDataRow(appId, table, rowKey);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  router.get("/v1/apps/:appId/membership", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const out = await ctx.repository.getAppMembership(appId);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  router.put("/v1/apps/:appId/custom-domain", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const body = ctx.json ?? {};
    const out = await ctx.repository.setAppCustomDomain(appId, body.domain);
    // Null means "not visible, or not yours to change". 404 either way, like
    // every other app mutation — telling the two apart leaks app existence.
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  router.post("/v1/apps/:appId/custom-domain/verify", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const out = await ctx.repository.verifyAppCustomDomain(appId);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  router.delete("/v1/apps/:appId/custom-domain", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const out = await ctx.repository.deleteAppCustomDomain(appId);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  router.get("/v1/apps/:appId/access", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const items = await ctx.repository.listAppAccess(appId);
    if (items === null) throw new ApiError(404, "not_found", "app not found");
    return { body: { items } };
  });

  router.put("/v1/apps/:appId/access/:memberId", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const memberId = decodeURIComponent(ctx.params.memberId);
    const body = ctx.json ?? {};
    requireString(body.permissionLevel, "permissionLevel");
    const out = await ctx.repository.setAppAccess(appId, memberId, body.permissionLevel);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  router.delete("/v1/apps/:appId/access/:memberId", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const memberId = decodeURIComponent(ctx.params.memberId);
    const ok = await ctx.repository.removeAppAccess(appId, memberId);
    if (!ok) throw new ApiError(404, "not_found", "app not found");
    return { body: { ok: true } };
  });


  // --- App file storage (design 2026-09-09-app-storage-design §7) ---
  //
  // Seven routes for people, gated on app_member_access exactly as the data
  // browser is, and one for the app itself. That last one is the only route in
  // this file that does not run under a user JWT; it is marked `app-token` and
  // the repository method it calls is the entire authorization check.

  router.get("/v1/apps/:appId/storage/usage", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const out = await ctx.repository.getAppStorageUsage(appId);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  router.post("/v1/apps/:appId/storage/usage/refresh", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const out = await ctx.repository.refreshAppStorageUsage(appId);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  router.get("/v1/apps/:appId/storage/objects", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const out = await ctx.repository.listAppFiles(appId, {
      prefix: ctx.query.get("prefix"),
      after: ctx.query.get("after"),
      limit: parseLimit(ctx.query.get("limit")),
    });
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  router.get("/v1/apps/:appId/storage/objects/:key/url", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const path = decodeFilePath(decodeURIComponent(ctx.params.key));
    const out = await ctx.repository.createAppFileDownloadUrl(appId, path);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  router.post("/v1/apps/:appId/storage/sign-upload", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const body = ctx.json ?? {};
    requireString(body.path, "path");
    const out = await ctx.repository.createAppFileUploadUrl(appId, {
      path: body.path,
      contentType: typeof body.contentType === "string" ? body.contentType : null,
    });
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  router.delete("/v1/apps/:appId/storage/objects/:key", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const path = decodeFilePath(decodeURIComponent(ctx.params.key));
    const out = await ctx.repository.deleteAppFile(appId, path);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  router.post("/v1/apps/:appId/storage/purge", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const out = await ctx.repository.purgeAppFiles(appId);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  router.put("/v1/apps/:appId/storage/quota", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const raw = (ctx.json ?? {}).quotaBytes;
    if (raw !== null && typeof raw !== "number") {
      throw new ApiError(400, "validation_failed", "quotaBytes must be a number or null");
    }
    const out = await ctx.repository.setAppStorageQuota(appId, raw);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  // --- App scheduled tasks (design 2026-09-10-app-control-panel §5/§6) ---
  //
  // Reads are open to anyone the app has named; every write is `admin`, and the
  // repository is the only place that decides which is which. A null return is
  // 404 for the same reason every other app route does it: telling "you may
  // not" apart from "it does not exist" leaks which apps exist.

  router.get("/v1/apps/:appId/cron-jobs", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const items = await ctx.repository.listAppCronJobs(appId);
    if (items === null) throw new ApiError(404, "not_found", "app not found");
    return { body: { items } };
  });

  router.post("/v1/apps/:appId/cron-jobs", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const body = ctx.json ?? {};
    requireString(body.name, "name");
    requireString(body.schedule, "schedule");
    const out = await ctx.repository.createAppCronJob(appId, body);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { statusCode: 201, body: out };
  });

  router.patch("/v1/apps/:appId/cron-jobs/:jobId", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const jobId = decodeURIComponent(ctx.params.jobId);
    const out = await ctx.repository.updateAppCronJob(appId, jobId, ctx.json ?? {});
    if (!out) throw new ApiError(404, "not_found", "cron job not found");
    return { body: out };
  });

  router.delete("/v1/apps/:appId/cron-jobs/:jobId", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const jobId = decodeURIComponent(ctx.params.jobId);
    const ok = await ctx.repository.deleteAppCronJob(appId, jobId);
    if (!ok) throw new ApiError(404, "not_found", "cron job not found");
    return { body: { ok: true } };
  });

  // Runs the job's request immediately and answers with the outcome. The
  // schedule is untouched — see runAppCronJobNow.
  router.post("/v1/apps/:appId/cron-jobs/:jobId/run", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const jobId = decodeURIComponent(ctx.params.jobId);
    const out = await ctx.repository.runAppCronJobNow(appId, jobId);
    if (!out) throw new ApiError(404, "not_found", "cron job not found");
    return { body: out };
  });

  router.get("/v1/apps/:appId/cron-jobs/:jobId/runs", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const jobId = decodeURIComponent(ctx.params.jobId);
    // parseLimit's own default is the 50-row list default, which is not this
    // endpoint's: only 20 runs per job are ever kept. It still validates the
    // value when one is given, so garbage is a 400 rather than a silent clamp.
    const rawLimit = ctx.query.get("limit");
    const items = await ctx.repository.listAppCronRuns(
      appId,
      jobId,
      rawLimit ? parseLimit(rawLimit) : 20,
    );
    if (items === null) throw new ApiError(404, "not_found", "app not found");
    return { body: { items } };
  });

  // The one-minute heartbeat. Both deploy targets drive this same path — a
  // compose sidecar on self-host, a timer trigger on Alibaba FC — so a job
  // behaves identically wherever it runs. `auth: "cron-tick"` is the whole
  // authentication: a constant-time compare against APP_CRON_SECRET, which
  // fails closed when the variable is unset.
  router.post("/v1/internal/app-cron/tick", { auth: "cron-tick" }, async () => {
    const out = await runDueAppCronJobs({ client: createServiceRoleClient() });
    return { body: out };
  });

  // The deployed app asking for its own credentials. `auth: "app-token"` gets a
  // service-role repository and authenticates NOTHING - mintAppStorageCredentials
  // does the constant-time token compare, and a mismatch is indistinguishable
  // from an unknown app on purpose.
  router.post("/v1/apps/:appId/storage/sts", { auth: "app-token" }, async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const header = ctx.getHeader("authorization") ?? "";
    const token = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() ?? "";
    if (!token) throw new ApiError(401, "unauthorized", "app storage token required");
    const out = await ctx.repository.mintAppStorageCredentials(appId, token);
    if (!out) throw new ApiError(401, "unauthorized", "app storage token is not valid");
    return { body: out.credentials };
  });

}
