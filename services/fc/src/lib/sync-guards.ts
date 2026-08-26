// services/fc/src/lib/sync-guards.ts
//
// Server-side backstop for the sync write path.
//
// The client has ignore rules and size/count guards of its own
// (`apps/daemon/src/sync/oss/ignore_rules.rs`, `engine::plan_push`), and they
// are the first line of defence. This file exists because an older client
// predates them and still pushes whatever it likes — and because `/v1/sync/*`
// is deliberately exempt from the per-IP rate limiter, so the write path has no
// other ceiling of its own.
//
// ## Why this list is so much shorter than the client's
//
// A false positive here is permanent and unexplainable from the user's side:
// their document never uploads, the client retries forever, and all they see is
// a 422. So the server only refuses names that cannot plausibly be a document
// somebody wrote.
//
// The client's list is free to be aggressive because a person can edit
// `.amuxignore` and get their file back. Nobody can edit this one. In
// particular `target/`, `build/`, `dist/` and `coverage/` are NOT here: a
// Chinese-speaking team may well keep OKRs under `target/`, or notes on the
// build process under `build/`. On the client those cost an edit; here they
// would cost the document.
//
// Everything else is left to the quota, which cannot produce a false positive —
// it only triggers on volume that is a problem regardless of what the files are
// called.

/**
 * Path prefixes the write path refuses, relative to the vault root.
 *
 * Directory names only, matched at any depth. Anything added here must be
 * something no human would name a folder of notes.
 */
const REJECTED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '__pycache__',
  '.pnpm-store',
]);

/** Exact file names the write path refuses, at any depth. */
const REJECTED_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/**
 * Whether the sync write path should refuse `path`.
 *
 * `path` is the wire form — `knowledge/notes/a.md`. Read-side callers must not
 * use this: the pull loop applies a whole manifest, and rejecting one historical
 * row aborts the rest (see `RETIRED_PREFIXES` in the client's path validator for
 * what that failure looks like). This is a WRITE guard only.
 */
export function isRejectedSyncPath(path: string): boolean {
  const segments = path.split('/');
  // Every segment except the last is a directory on the way down.
  for (let i = 0; i < segments.length - 1; i++) {
    if (REJECTED_DIR_NAMES.has(segments[i])) return true;
  }
  const leaf = segments[segments.length - 1];
  return REJECTED_DIR_NAMES.has(leaf) || REJECTED_FILE_NAMES.has(leaf);
}

/**
 * Largest number of live files one team may hold.
 *
 * Not a business limit — a resource one. A knowledge base nobody has dropped a
 * repo into does not approach this; a single `node_modules` can pass it on its
 * own. Configurable so it can be raised for a team that legitimately grows into
 * it without a redeploy.
 */
export function maxFilesPerTeam(): number {
  const raw = Number(process.env.SYNC_MAX_FILES_PER_TEAM);
  return Number.isFinite(raw) && raw > 0 ? raw : 50_000;
}

// Counting live files is one round-trip, and a 200-item batch would otherwise
// pay for it 200 times. A short TTL is fine: this is a resource ceiling, not a
// security boundary, so a team briefly running over it is not a failure.
const COUNT_TTL_MS = 10_000;
const countCache = new Map<string, { at: number; count: number }>();

/** Drop cached counts. Tests only — production entries expire on their own. */
export function resetQuotaCache(): void {
  countCache.clear();
}

/**
 * How many live files this team has, cached for {@link COUNT_TTL_MS}.
 *
 * Returns `null` when the count cannot be established. Callers treat that as
 * "allow": failing an upload because a COUNT query hiccupped would break sync
 * for a reason the user can do nothing about, and the guard exists for a
 * pathological case, not a routine one.
 */
export async function liveFileCount(
  teamId: string,
  countFiles: (teamId: string) => Promise<number | null>,
): Promise<number | null> {
  const hit = countCache.get(teamId);
  if (hit && Date.now() - hit.at < COUNT_TTL_MS) return hit.count;
  const count = await countFiles(teamId).catch(() => null);
  if (count === null) return null;
  countCache.set(teamId, { at: Date.now(), count });
  return count;
}

/**
 * Whether this team is at or over its file ceiling.
 *
 * `null` count → not over: see {@link liveFileCount}.
 */
export function isOverFileQuota(count: number | null): boolean {
  return count !== null && count >= maxFilesPerTeam();
}
