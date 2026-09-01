// ---------------------------------------------------------------------------
// Shared HTTP response helper for the FC admin/team handlers.
//
// Extracted from admin-handlers.ts so infra modules (oss-store, sts,
// codeup) and route handlers can build JSON responses without importing the
// handler module (which would create import cycles).
// ---------------------------------------------------------------------------
export function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
