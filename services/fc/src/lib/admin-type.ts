/**
 * `public.users.admin_type` — an identity tier, not a permission (ADR-0016).
 *
 * Code may ask only two things of it: is this identity a member (`isMember`),
 * and — in SQL, `amux.is_platform_operator` — is it a platform operator. What a
 * creator may do is decided by org roles, never by `>= CREATOR`.
 */
export const ADMIN_TYPE = {
  /** Has an identity in the org but is not a member (e.g. signed in to one app). */
  GUEST: 1,
  /** A member of the org, person or agent. */
  MEMBER: 2,
  /** Created the org. */
  CREATOR: 3,
  /** Runs this deployment; only meaningful in the platform org. */
  PLATFORM_OPERATOR: 4,
} as const;

/** Reads the column the way every caller should: NULL / junk → 0 (unknown). */
export function adminTypeOf(row: { admin_type?: unknown } | null | undefined): number {
  const n = Number(row?.admin_type ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** May sign in to TeamClu. Keep in step with `amux.is_teamclu_identity()`. */
export function isMember(adminType: number | null | undefined): boolean {
  return typeof adminType === "number" && adminType >= ADMIN_TYPE.MEMBER;
}
