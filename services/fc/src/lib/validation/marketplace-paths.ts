/**
 * Object-storage paths for the first-party skills marketplace.
 *
 * Design: docs/architecture/skills-marketplace.md §4.2
 *
 * Backend-neutral on purpose: the blob namespace is shared between the
 * marketplace catalog and per-team skill packages, and both the repository
 * layer and any future collector have to agree on where the line falls.
 */

export function marketplaceObjectPath(contentHash: string): string {
  const hash = contentHash.toLowerCase();
  return `marketplace/blobs/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
}

/**
 * Whether blob GC is allowed to consider this object.
 *
 * Design §4.2: marketplace packages share the skills namespace with team
 * packages and are deliberately absent from `amuxc_blobs`, so any collector
 * that walks the whole namespace and deletes what that table does not mention
 * would wipe every marketplace package — silently, surfacing only at some
 * team's next install. Collection is restricted to `teams/<teamId>/`;
 * `marketplace/` is the catalog's own business.
 *
 * Currently asserted by tests rather than called by a collector: no skills-blob
 * GC exists yet. It is here so the one that gets written has the rule to import
 * instead of re-deriving it.
 */
export function isTeamScopedSkillObjectPath(objectPath: string): boolean {
  // The old `&& !startsWith("marketplace/")` could never fire — a path cannot
  // start with both prefixes — which read as a second guard while being none.
  return objectPath.startsWith("teams/");
}
