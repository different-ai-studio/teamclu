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

/** Editable state retains the raw rule separately from its displayed meaning. */
export type AppAuthRowState = {
  path: string
  requiresLogin: boolean
  audienceMode: 'any_authenticated' | 'any_org_role' | 'org_roles' | 'inherit'
  roleCodes: string[]
  originalRule?: AppAuthRule
  source: 'rule' | 'app_baseline'
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

type Policy = Pick<AppRow, 'authScope' | 'authAudience' | 'authRules'>
const cloneRule = (rule: AppAuthRule): AppAuthRule => ({ ...rule, ...(Array.isArray(rule.roles) ? { roles: [...rule.roles] } : {}) })
const modeOf = (rule: AppAuthRule): AppAuthRowState['audienceMode'] =>
  rule.auth === 'public' ? 'inherit' :
  rule.roles != null ? (rule.roles.length ? 'org_roles' : 'any_authenticated') :
    rule.audience === 'org' ? 'any_org_role' : rule.audience === 'any' ? 'any_authenticated' : 'inherit'

export function ruleToRowState(rule: AppAuthRule, _appAudience: AppAuthAudience): AppAuthRowState {
  return { path: rule.path, requiresLogin: rule.auth === 'required', audienceMode: modeOf(rule),
    roleCodes: rule.auth === 'public' ? [] : [...(rule.roles ?? [])], originalRule: cloneRule(rule), source: 'rule' }
}

export function sameAuthRow(a: AppAuthRowState, b: AppAuthRowState): boolean {
  return a.path === b.path && a.requiresLogin === b.requiresLogin && a.audienceMode === b.audienceMode &&
    a.roleCodes.length === b.roleCodes.length && a.roleCodes.every(code => b.roleCodes.includes(code))
}

export function rowStateToRule(row: AppAuthRowState): AppAuthRule {
  const original = row.originalRule
  if (original) {
    const parsed = ruleToRowState(original, 'org')
    // A path edit must not normalize an untouched audience, including dual fields.
    if (row.requiresLogin === parsed.requiresLogin && row.audienceMode === parsed.audienceMode &&
      row.roleCodes.length === parsed.roleCodes.length && row.roleCodes.every(code => parsed.roleCodes.includes(code))) {
      return { ...cloneRule(original), path: row.path }
    }
  }
  if (!row.requiresLogin) return { path: row.path, auth: 'public' }
  if (row.audienceMode === 'org_roles' && !row.roleCodes.length) throw new Error('Select at least one organization role')
  return { path: row.path, auth: 'required',
    ...(row.audienceMode === 'any_org_role' ? { audience: 'org' as const } :
      row.audienceMode === 'inherit' ? {} : { roles: row.audienceMode === 'org_roles' ? [...row.roleCodes] : [] }) }
}

export function sameAuthRules(a: AppAuthRule[], b: AppAuthRule[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// Match the gateway's stored-path reader, without the write normalizer's wildcard rewrite.
const isStoredRoot = (rule: AppAuthRule): boolean => rule.path.startsWith('/') &&
  rule.path.trim().replace(/\/+$/, '') === ''
const baselineRuleIndex = (app: Policy): number => (app.authRules ?? []).findIndex(isStoredRoot)

export function baselineToRowState(app: Policy): AppAuthRowState {
  const root = (app.authRules ?? [])[baselineRuleIndex(app)]
  if (root) return ruleToRowState(root, app.authAudience ?? 'org')
  return { path: '/', requiresLogin: app.authScope !== 'paths',
    audienceMode: app.authAudience === 'any' ? 'any_authenticated' : 'any_org_role', roleCodes: [], source: 'app_baseline' }
}

export function exceptionRulesToRowState(app: Policy): AppAuthRowState[] {
  const selectedIndex = baselineRuleIndex(app)
  return (app.authRules ?? []).filter((_r, index) => index !== selectedIndex)
    .map(r => ruleToRowState(r, app.authAudience ?? 'org'))
}

export function buildAuthPolicyPatch(baseline: AppAuthRowState, exceptions: AppAuthRowState[], originalPolicy: Policy): {
  authAudience: AppAuthAudience; authScope: AppAuthScope; authRules: AppAuthRule[]
} {
  const originalBaseline = baselineToRowState(originalPolicy)
  const baselineChanged = !sameAuthRow(baseline, originalBaseline)
  const authAudience = baselineChanged && baseline.source === 'app_baseline' && baseline.audienceMode !== 'org_roles'
    ? (baseline.audienceMode === 'any_authenticated' ? 'any' : 'org') : originalPolicy.authAudience ?? 'org'
  const authScope = baselineChanged ? (baseline.requiresLogin ? 'all' : 'paths') : originalPolicy.authScope ?? 'all'
  const rules = exceptions.map(rowStateToRule)
  const needsRoot = baseline.source === 'rule' || (baseline.requiresLogin && baseline.audienceMode === 'org_roles')
  if (needsRoot) {
    const root = rowStateToRule(baseline)
    const originalIndex = baselineRuleIndex(originalPolicy)
    const precedingRules = (originalPolicy.authRules ?? []).slice(0, originalIndex)
    const insertionIndex = originalIndex < 0 ? 0 : exceptions.filter(row => row.originalRule &&
      precedingRules.some(rule => sameAuthRules([rule], [row.originalRule!]))).length
    rules.splice(insertionIndex, 0, root)
  }
  return { authAudience, authScope, authRules: rules }
}

/** Read-only summary of the baseline wall (settings / control panel). */
export function summarizeAppAuthBaseline(
  app: Pick<AppRow, 'authMode' | 'authScope' | 'authAudience' | 'authRules'>,
): AppAuthAccessSummary {
  if (app.authMode !== 'platform') {
    return { requiresLogin: false, roleCodes: [] }
  }
  const scope: AppAuthScope = app.authScope ?? 'all'
  const root = (app.authRules ?? [])[baselineRuleIndex(app)]
  if (!root && scope === 'paths') return { requiresLogin: false, roleCodes: [] }
  if (root?.auth === 'public') return { requiresLogin: false, roleCodes: [] }
  if (root && root.roles != null) {
    return { requiresLogin: true, roleCodes: [...root.roles] }
  }
  const audience: AppAuthAudience = root?.audience ?? app.authAudience ?? 'org'
  if (audience === 'any') {
    return { requiresLogin: true, roleCodes: [] }
  }
  // Legacy org without explicit roles — do not pretend it is "any user".
  return { requiresLogin: true, roleCodes: null }
}
