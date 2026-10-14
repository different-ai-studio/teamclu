/** Design: docs/specs/2026-10-14-document-library-role-access-design.md */

export type CallerRoles = { ids: string[]; codes: string[] };

export type LibraryAudience =
  | { kind: "open" }
  | { kind: "actors"; actorIds: string[] }
  | { kind: "roles"; roleCodes: string[] };

export type MemberAccess = { actorId: string; roleCodes: string[] };

const LIBRARY_PREFIX = /^documents\/[^/]+\/$/;

export function isDocumentLibraryPrefix(prefix: string): boolean {
  return LIBRARY_PREFIX.test(prefix);
}

/** Both arguments are stored prefixes and already end in `/`. */
export function documentPrefixesOverlap(a: string, b: string): boolean {
  if (!a.startsWith("documents/") || !b.startsWith("documents/")) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * True when this caller must not see a folder granted to `grantedRoleIds`.
 * `owner` passes even if that role id is absent from the grant rows.
 * `admin` does not pass unless it is one of the granted ids.
 */
export function roleRuleDenies(caller: CallerRoles, grantedRoleIds: string[]): boolean {
  if (caller.codes.includes("owner")) return false;
  const held = new Set(caller.ids);
  return !grantedRoleIds.some((id) => held.has(id));
}

function canSee(member: MemberAccess, audience: LibraryAudience): boolean {
  if (audience.kind === "open") return true;
  if (audience.kind === "actors") return audience.actorIds.includes(member.actorId);
  if (member.roleCodes.includes("owner")) return true;
  return member.roleCodes.some((code) => audience.roleCodes.includes(code));
}

/** Member actor ids who can see `previously` and cannot see the next role set. */
export function membersLosingLibraryAccess(
  members: MemberAccess[],
  previously: LibraryAudience,
  nextRoleCodes: string[],
): string[] {
  const next: LibraryAudience = { kind: "roles", roleCodes: nextRoleCodes };
  return members.filter((member) => canSee(member, previously) && !canSee(member, next)).map((member) => member.actorId);
}
