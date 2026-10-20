/** Design: docs/specs/2026-10-14-document-library-role-access-design.md */

export type CallerRoles = { ids: string[]; codes: string[] };

export type LibraryAudience =
  | { kind: "open" }
  | { kind: "actors"; actorIds: string[] }
  | { kind: "roles"; roleCodes: string[] };

export type MemberAccess = { actorId: string; roleCodes: string[] };

const LIBRARY_PREFIX = /^documents\/[^/]+\/$/;
/** Same ceiling as `validateAclPrefix` in sync-acl.ts. */
const MAX_PREFIX_LENGTH = 1024;

/**
 * A top-level `documents/<folder>/` prefix. Also applies the legacy
 * `validateAclPrefix` limits: no `..` anywhere and at most 1024 characters.
 */
export function isDocumentLibraryPrefix(prefix: string): boolean {
  return LIBRARY_PREFIX.test(prefix) && !prefix.includes("..") && prefix.length <= MAX_PREFIX_LENGTH;
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

/**
 * Prefixes to push back into the manifest after roles are added.
 * `addedOwner` includes every library: owner can read one even when the owner
 * role id is absent from its grant rows. Removal passes an empty `addedRoleIds`
 * and resurfaces nothing.
 */
export function libraryPrefixesToResurface(input: {
  libraries: Array<{ pathPrefix: string; roleIds: string[] }>;
  addedRoleIds: string[];
  addedOwner: boolean;
}): string[] {
  if (input.addedOwner) return input.libraries.map((library) => library.pathPrefix);
  const added = new Set(input.addedRoleIds);
  return input.libraries
    .filter((library) => library.roleIds.some((roleId) => added.has(roleId)))
    .map((library) => library.pathPrefix);
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

/**
 * Whether saving `nextRoleIds` over `previously` can let someone in who was
 * shut out, so the folder's existing files must be resurfaced.
 *
 * Restricting an open folder lets no one new in. Replacing a per-member rule
 * can. Changing a role rule widens only when it adds a role id.
 */
export function libraryGrantWidens(
  previously: { kind: "open" } | { kind: "actors" } | { kind: "roles"; roleIds: string[] },
  nextRoleIds: string[],
): boolean {
  if (previously.kind === "open") return false;
  if (previously.kind === "actors") return true;
  const before = new Set(previously.roleIds);
  return nextRoleIds.some((id) => !before.has(id));
}
