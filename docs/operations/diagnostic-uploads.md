# Diagnostic support uploads (#1875)

## Client flow and privacy

Desktop Settings → Diagnostics → Export & Feedback → **Upload diagnostic ZIP**
shows consent before collecting/uploading anything. Local export and report copy
remain independent. Both upload and export call the same `buildDiagnosticZipBytes`
→ `build_diagnostic_zip` path; this change adds no extra files or redaction rules.
Existing log redaction is best effort, **not a guarantee that logs contain no
personal data**. The dialog lists logs, console output, runtime snapshots and
connection/environment metadata and offers local inspection first. Do not upload
production diagnostics during development/testing.

## Deployment (manual; no resources or migrations created by this PR)

- Opt in with `DIAGNOSTICS_STORAGE_BUCKET` on the Cloud API. Blank/unset fails
  closed with 503 and leaves local export working. The optional key is declared
  in both deployment environment allowlists.
- Use a **private** OSS/S3-compatible bucket with all public access blocked.
  Never use a public artifact bucket or a public CDN mapping. The API uses the
  existing server-only `ACCESS_KEY_ID`, `ACCESS_KEY_SECRET`, `REGION`, `ENDPOINT`
  and `S3_FORCE_PATH_STYLE` configuration (`lib/oss.ts`). Clients receive no
  credentials or object-store upload grants. No bucket CORS changes are needed:
  bytes go through the authenticated Cloud API, not directly from the browser.
- Grant the API principal PutObject/GetObject (including HEAD) only for
  `<diagnostics bucket>/diagnostics/*` as appropriate. Use encryption at rest
  and your deployment's normal audit logging. Keep signed download URL queries
  out of logs/analytics and never post them publicly.
- **Required lifecycle rule:** expire `diagnostics/` objects after 7 days; remove
  noncurrent versions too if bucket versioning is enabled. API access expires
  after 7 days regardless, but actual deletion is the storage lifecycle's job.
  Verify the lifecycle and block-public-access policies before enabling the key.
  No SQL migration/new service is needed: object metadata records owner id,
  creation/expiry timestamps, byte size and SHA-256. Receipt ids are random UUIDs;
  keys never contain client-provided filenames, paths or team ids.
- Configure reverse proxy/runtime request limits to allow 10 MiB binary bodies
  (FC-specific payload limits may be lower: check the target). The API itself
  bounds declared and streaming bodies to 10 MiB before buffering. Do not raise
  that cap without reviewing memory/runtime limits. No archive extraction occurs
  server-side; ZIP magic validation is only a format sanity check, not malware
  scanning. Support must treat archives/logs as untrusted data.
- Upload damping is 3 requests/minute/user **per API process**, reusing the
  existing in-memory limiter. It is not a distributed quota; use gateway quotas
  or monitoring for multi-replica deployments and abuse prevention.

## API/support workflow

All endpoints require a valid bearer session, including download URL resolution.
The caller identity/operator decision uses the existing `getAdminWhoami` path
(verified current user and platform operator policy). A shared org support
account is **not** implicitly a platform operator. No team member/admin can read
another member's diagnostics solely because of team membership.

1. `POST /v1/diagnostics`, `Content-Type: application/zip`, raw ZIP body (1–10 MiB).
   Returns 201 `{ receiptId, expiresAt }` only after storage succeeds. The receipt
   is safe to paste in a feedback ticket but is **not** a public download link.
2. User sends the copied receipt to support via their chosen feedback channel.
3. A signed-in **platform operator** resolves that receipt using
   `GET /v1/diagnostics/<receiptId>` with their own bearer session (or the uploader
   can resolve their own). Response: `{ receiptId, expiresAt, downloadUrl,
   downloadExpiresAt }`. Download the ZIP using `downloadUrl` within 15 minutes
   (or less if receipt expiry is sooner). This signed URL is a temporary bearer
   capability: do not share it. Request a fresh one after expiry.
4. Other authenticated users receive the same 404 as a missing object; malformed
   ids return 400; expired receipts return 410; missing config is 503; invalid
   MIME/ZIP is 415/422; size limit is 413; rate limit is 429. Storage/network
   failures return sanitized 502 errors. Responses are `Cache-Control: no-store`.

There is deliberately no public receipt-to-file endpoint, listing/search UI,
email delivery, production upload, or automatic deployment. Support can use its
existing authenticated API tooling; a dedicated operator UI is outside this
issue. Offline/network/auth failures remain retryable through the upload button;
local export does not depend on the Cloud API. There is no automatic upload retry
apart from the shared client's one-time auth refresh on 401, so an ambiguous
network failure may leave an unreturned object until lifecycle cleanup.
