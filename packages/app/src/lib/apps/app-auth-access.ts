/**
 * App login-wall path rules: UI row state ↔ stored authScope / authAudience /
 * authRules, plus short summary copy for settings / control panel.
 */

import type {
  AppAuthAudience,
  AppAuthRule,
  AppAuthScope,
  AppRow,
} from '@/lib/backend/types'

/** One editable row (baseline or a path exception). */
export type AppAuthRowState = {
  path: string
  requiresLogin: boolean
  /** Only meaningful when `requiresLogin`. Empty = any signed-in user. */
  roleCodes: string[]
}

export type AppAuthAccessSummary = {
  requiresLogin: boolean
  /**
   * `null` = legacy `audience: org` with no explicit roles (any org member who
   * has at least one active role). Empty array = any authenticated user.
   */
  roleCodes: string[] | null
}

/** Chinese / source fallbacks — callers pass through `t()` with these. */
export const APP_AUTH_ACCESS_FALLBACKS = {
  public: '不需要登录',
  any: '需要登录 · 任意用户',
  orgLegacy: '需要登录 · 组织角色',
} as const

export function formatAppAuthAccessSummary(summary: AppAuthAccessSummary): string {
  if (!summary.requiresLogin) return APP_AUTH_ACCESS_FALLBACKS.public
  if (summary.roleCodes === null) return APP_AUTH_ACCESS_FALLBACKS.orgLegacy
  if (summary.roleCodes.length === 0) return APP_AUTH_ACCESS_FALLBACKS.any
  return `需要登录 · ${summary.roleCodes.join(', ')}`
}

function effectiveAudience(
  rule: AppAuthRule | undefined,
  appAudience: AppAuthAudience,
): AppAuthAudience {
  return rule?.audience ?? appAudience
}

/**
 * Map a stored rule into UI state. `allRoleCodes` is used when legacy
 * `audience: org` (or inherited org) has no `roles` — prefill every active
 * org role code so a save migrates off audience.
 */
export function ruleToRowState(
  rule: AppAuthRule,
  appAudience: AppAuthAudience,
  allRoleCodes: string[],
): AppAuthRowState {
  if (rule.auth === 'public') {
    return { path: rule.path, requiresLogin: false, roleCodes: [] }
  }
  if (rule.roles !== undefined) {
    return { path: rule.path, requiresLogin: true, roleCodes: [...rule.roles] }
  }
  const audience = effectiveAudience(rule, appAudience)
  return {
    path: rule.path,
    requiresLogin: true,
    roleCodes: audience === 'org' ? [...allRoleCodes] : [],
  }
}

export function rowStateToRule(row: AppAuthRowState): AppAuthRule {
  if (!row.requiresLogin) return { path: row.path, auth: 'public' }
  return { path: row.path, auth: 'required', roles: [...row.roleCodes] }
}

export function sameAuthRules(a: AppAuthRule[], b: AppAuthRule[]): boolean {
  if (a.length !== b.length) return false
  return a.every((r, i) => {
    const o = b[i]
    if (r.path !== o.path || r.auth !== o.auth) return false
    const ra = r.roles
    const oa = o.roles
    if (ra === undefined && oa === undefined) {
      return r.audience === o.audience
    }
    if (ra === undefined || oa === undefined) return false
    if (ra.length !== oa.length) return false
    return ra.every((code, j) => code === oa[j])
  })
}

/**
 * Baseline from authScope + authAudience (+ optional `/` rule with roles).
 * When a `/` required rule carries explicit `roles`, that is the baseline WHO
 * and the rule is excluded from the exception list by the loader.
 */
export function baselineToRowState(
  app: Pick<AppRow, 'authScope' | 'authAudience' | 'authRules'>,
  allRoleCodes: string[],
): AppAuthRowState {
  const scope: AppAuthScope = app.authScope ?? 'all'
  const audience: AppAuthAudience = app.authAudience ?? 'org'
  const rules = app.authRules ?? []
  const root = rules.find((r) => r.path === '/' && r.auth === 'required')

  if (scope === 'paths') {
    return { path: '/', requiresLogin: false, roleCodes: [] }
  }

  if (root && root.roles !== undefined) {
    return { path: '/', requiresLogin: true, roleCodes: [...root.roles] }
  }

  if (root) {
    return ruleToRowState(root, audience, allRoleCodes)
  }

  return {
    path: '/',
    requiresLogin: true,
    roleCodes: audience === 'org' ? [...allRoleCodes] : [],
  }
}

/**
 * Path exceptions for the editor. Under `authScope: all`, a `/` required rule
 * is the baseline WHO and is omitted here (see `baselineToRowState`).
 */
export function exceptionRulesToRowState(
  app: Pick<AppRow, 'authScope' | 'authAudience' | 'authRules'>,
  allRoleCodes: string[],
): AppAuthRowState[] {
  const scope: AppAuthScope = app.authScope ?? 'all'
  const audience: AppAuthAudience = app.authAudience ?? 'org'
  const rules = app.authRules ?? []
  const dropRootBaseline =
    scope !== 'paths' && rules.some((r) => r.path === '/' && r.auth === 'required')

  return rules
    .filter((r) => !(dropRootBaseline && r.path === '/'))
    .map((r) => ruleToRowState(r, audience, allRoleCodes))
}

/**
 * Build the PATCH body. Baseline login is encoded as authScope=all plus a `/`
 * required rule with `roles` (so WHO migrates off authAudience). Public
 * baseline is authScope=paths with no injected `/`.
 */
/**
 * `auth_audience` is legacy, but it is still the gateway's LAST-RESORT answer to
 * "who may enter" — the one it uses when a path's own verdict cannot be read
 * (an encoded separator, a corrupt rule set). Writing `any` unconditionally
 * made that last resort admit every signed-in visitor, including for an app
 * whose every rule names specific roles. So it tracks the policy: `any` only
 * when nothing here restricts anybody.
 */
function fallbackAudience(rows: AppAuthRowState[]): AppAuthAudience {
  const restricts = rows.some((r) => r.requiresLogin && r.roleCodes.length > 0)
  return restricts ? 'org' : 'any'
}

export function buildAuthPolicyPatch(
  baseline: AppAuthRowState,
  exceptions: AppAuthRowState[],
): {
  authAudience: AppAuthAudience
  authScope: AppAuthScope
  authRules: AppAuthRule[]
} {
  const exceptionRules = exceptions.map(rowStateToRule)
  if (!baseline.requiresLogin) {
    return {
      authAudience: fallbackAudience(exceptions),
      authScope: 'paths',
      authRules: exceptionRules,
    }
  }

  const rootRule = rowStateToRule({ ...baseline, path: '/' })
  const withoutRoot = exceptionRules.filter((r) => r.path !== '/')
  return {
    authAudience: fallbackAudience([baseline, ...exceptions]),
    authScope: 'all',
    authRules: [rootRule, ...withoutRoot],
  }
}

/** Read-only summary of the baseline wall (settings / control panel). */
export function summarizeAppAuthBaseline(
  app: Pick<AppRow, 'authMode' | 'authScope' | 'authAudience' | 'authRules'>,
): AppAuthAccessSummary {
  if (app.authMode !== 'platform') {
    return { requiresLogin: false, roleCodes: [] }
  }
  const scope: AppAuthScope = app.authScope ?? 'all'
  if (scope === 'paths') {
    return { requiresLogin: false, roleCodes: [] }
  }
  const root = (app.authRules ?? []).find((r) => r.path === '/' && r.auth === 'required')
  if (root && root.roles !== undefined) {
    return { requiresLogin: true, roleCodes: [...root.roles] }
  }
  const audience: AppAuthAudience = app.authAudience ?? 'org'
  if (audience === 'any') {
    return { requiresLogin: true, roleCodes: [] }
  }
  // Legacy org without explicit roles — do not pretend it is "any user".
  return { requiresLogin: true, roleCodes: null }
}
