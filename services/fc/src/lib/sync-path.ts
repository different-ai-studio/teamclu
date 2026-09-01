// services/fc/lib/sync-path.mjs
//
// Path validation for /sync/* endpoints (spec §3.1.1).
// All endpoints that accept a `path` field call validateSyncPath() and return
// 422 InvalidPath if it fails.

// File sync carries documents only. Everything else that used to live here
// moved to a purpose-built API: skills to the skills registry, `.mcp/` and
// `_secrets/` to the team MCP / env endpoints, and the team LLM config that
// `_meta/` was meant to hold to /v1/teams/:id/workspace-config.
// The two fixed roots of the synced tree. Must stay identical to the Rust
// copies in apps/daemon/src/sync/oss/path_validator.rs and
// apps/desktop/src/commands/oss_sync/path_validator.rs.
//
// This one is the server's, so it is also the one that decides whether a new
// prefix can be uploaded at all. Widening it first is the safe order: the
// server accepting a prefix no client uses yet is harmless, while a client
// pushing a prefix the server rejects is a 422 the user cannot act on.
export const ALLOWED_PREFIXES = ['documents/', 'knowledge/'];

/**
 * Validate a sync path coming from the wire.
 *
 * Returns { ok: true } on success or
 *         { ok: false, code: 'InvalidPath', message: string } on failure.
 *
 * Rejected cases (spec §3.1.1):
 *  - Non-string or empty string
 *  - Total length > 1024 bytes
 *  - Contains NUL byte (\0)
 *  - Contains control characters (< 0x20)
 *  - Contains backslash (Windows separator)
 *  - Absolute path (starts with /) or drive letter (C:\...)
 *  - Any segment that is '' (empty), '.', or '..'
 *  - Any segment longer than 255 bytes
 *  - Does not start with one of the allowed prefixes
 *
 * @param {unknown} path
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
export function validateSyncPath(path) {
  if (typeof path !== 'string' || path.length === 0) {
    return { ok: false, code: 'InvalidPath', message: 'path must be a non-empty string' };
  }

  if (path.length > 1024) {
    return { ok: false, code: 'InvalidPath', message: 'path exceeds 1024 bytes' };
  }

  // NUL byte
  if (path.includes('\0')) {
    return { ok: false, code: 'InvalidPath', message: 'path contains NUL byte' };
  }

  // Control characters (< 0x20, excluding NUL already caught above)
  // eslint-disable-next-line no-control-regex
  if (/[\x01-\x1f]/.test(path)) {
    return { ok: false, code: 'InvalidPath', message: 'path contains control character' };
  }

  // Backslash (Windows path separator)
  if (path.includes('\\')) {
    return { ok: false, code: 'InvalidPath', message: 'path contains backslash; use forward slashes' };
  }

  // Absolute path
  if (path.startsWith('/')) {
    return { ok: false, code: 'InvalidPath', message: 'absolute path not allowed' };
  }

  // Windows drive letter (e.g. C:, c:)
  if (/^[a-zA-Z]:/.test(path)) {
    return { ok: false, code: 'InvalidPath', message: 'drive letter not allowed' };
  }

  // UNC path
  if (path.startsWith('//')) {
    return { ok: false, code: 'InvalidPath', message: 'UNC path not allowed' };
  }

  // Segment-level checks
  const segments = path.split('/');
  for (const seg of segments) {
    if (seg === '') {
      return { ok: false, code: 'InvalidPath', message: 'path contains empty segment (double slash or trailing slash)' };
    }
    if (seg === '.') {
      return { ok: false, code: 'InvalidPath', message: 'path contains "." segment' };
    }
    if (seg === '..') {
      return { ok: false, code: 'InvalidPath', message: 'path contains ".." segment (directory traversal)' };
    }
    if (seg.length > 255) {
      return { ok: false, code: 'InvalidPath', message: `path segment "${seg.slice(0, 20)}…" exceeds 255 bytes` };
    }
  }

  // Allowed prefix check.
  // A path exactly equal to a prefix without trailing slash is also allowed
  // (e.g. "skills" is NOT valid since it has no slash, but "skills/foo" is).
  // The prefixes all end with '/'.  A path like "skills/foo" starts with
  // "skills/", which is one of our prefixes.  A path of exactly "skills/"
  // also starts with "skills/" and is technically valid (empty filename is
  // already rejected by the empty-segment check above, so this can't happen).
  if (!ALLOWED_PREFIXES.some(p => path.startsWith(p))) {
    return {
      ok: false,
      code: 'InvalidPath',
      message: `path must start with one of: ${ALLOWED_PREFIXES.join(', ')}`,
    };
  }

  return { ok: true };
}
