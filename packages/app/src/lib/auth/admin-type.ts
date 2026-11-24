/**
 * `public.users.admin_type` — an identity tier, not a permission (ADR-0016).
 * Mirrors services/fc/src/lib/admin-type.ts. Clients only label with it; what
 * someone may do comes from org roles.
 */
export const ADMIN_TYPE = {
  GUEST: 1,
  MEMBER: 2,
  CREATOR: 3,
  PLATFORM_OPERATOR: 4,
} as const

export type AdminTypeLabel = 'guest' | 'creator' | 'platformOperator'

/**
 * Which label an identity carries, or null for an ordinary member (the norm,
 * not worth a label) and unknown values. A client cannot tell whether a 4 sits
 * in the platform org, so the label is a hint, not a grant.
 */
export function adminTypeLabel(adminType: number): AdminTypeLabel | null {
  switch (adminType) {
    case ADMIN_TYPE.GUEST:
      return 'guest'
    case ADMIN_TYPE.CREATOR:
      return 'creator'
    case ADMIN_TYPE.PLATFORM_OPERATOR:
      return 'platformOperator'
    default:
      return null
  }
}
