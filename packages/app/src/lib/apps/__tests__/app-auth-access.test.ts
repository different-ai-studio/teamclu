import { describe, expect, it } from 'vitest'
import { baselineToRowState, buildAuthPolicyPatch, exceptionRulesToRowState, ruleToRowState, rowStateToRule, summarizeAppAuthBaseline } from '../app-auth-access'
import type { AppAuthRule, AppAuthAudience } from '@/lib/backend/types'

describe('lossless auth policy editor', () => {
  const cases: AppAuthRule[] = [
    { path: '/staff', auth: 'required', audience: 'org' },
    { path: '/staff', auth: 'required', audience: 'org', roles: [] },
    { path: '/staff', auth: 'required', audience: 'any', roles: ['reviewer'] },
    { path: '/staff', auth: 'required', audience: 'any' },
    { path: '/staff', auth: 'required' },
    { path: '/staff', auth: 'public', audience: 'org' },
  ]
  for (const audience of ['org', 'any'] as AppAuthAudience[]) for (const rule of cases) {
    it(`round trips ${JSON.stringify(rule)} inherited from ${audience}`, () => {
      const before = JSON.stringify(rule)
      const row = ruleToRowState(rule, audience)
      expect(rowStateToRule(row)).toEqual(rule)
      expect(JSON.stringify(rule)).toBe(before)
      expect(row.originalRule).not.toBe(rule)
    })
  }
  it('keeps dynamic org distinct from fixed roles and explicit empty roles', () => {
    expect(ruleToRowState(cases[0], 'any').audienceMode).toBe('any_org_role')
    expect(ruleToRowState(cases[0], 'any').roleCodes).toEqual([])
    expect(ruleToRowState(cases[1], 'org').audienceMode).toBe('any_authenticated')
    expect(ruleToRowState(cases[2], 'org').audienceMode).toBe('org_roles')
    expect(ruleToRowState(cases[4], 'org').audienceMode).toBe('inherit')
  })
  it('does not inject a missing root or change the app default when another path changes', () => {
    const app = { authScope: 'all' as const, authAudience: 'org' as const, authRules: [cases[0], cases[4]] }
    const before = JSON.stringify(app)
    const baseline = baselineToRowState(app)
    const rows = exceptionRulesToRowState(app)
    rows[1] = { ...rows[1], path: '/other' }
    expect(buildAuthPolicyPatch(baseline, rows, app)).toEqual({ ...app, authRules: [cases[0], { path: '/other', auth: 'required' }] })
    expect(JSON.stringify(app)).toBe(before)
  })
  it('normalizes only an explicitly changed audience and rejects empty fixed selection', () => {
    const row = ruleToRowState(cases[2], 'org')
    expect(rowStateToRule({ ...row, audienceMode: 'any_org_role', roleCodes: [] })).toEqual({ path: '/staff', auth: 'required', audience: 'org' })
    expect(() => rowStateToRule({ ...row, roleCodes: [] })).toThrow()
  })
  it('preserves rule order around an existing root', () => {
    const app = { authScope: 'all' as const, authAudience: 'any' as const, authRules: [cases[0], { path: '/', auth: 'required' as const, roles: ['reviewer'] }, cases[4]] }
    expect(buildAuthPolicyPatch(baselineToRowState(app), exceptionRulesToRowState(app), app)).toEqual(app)
  })
  it('keeps a root in relative order when an earlier exception is removed', () => {
    const app = { authScope: 'all' as const, authAudience: 'org' as const, authRules: [
      { path: '/remove', auth: 'public' as const }, { path: '/', auth: 'required' as const, audience: 'org' as const }, cases[4],
    ] }
    const exceptions = exceptionRulesToRowState(app).slice(1)
    expect(buildAuthPolicyPatch(baselineToRowState(app), exceptions, app).authRules).toEqual(app.authRules.slice(1))
  })

})

describe('gateway-readable stored compatibility', () => {
 it('preserves nullable WHO fields for public and required rules on path edits', () => {
  for (const auth of ['public','required'] as const) for (const audience of [null,'org','any'] as const) {
   const rule = {path:'/staff',auth,roles:null,audience} as unknown as AppAuthRule
   const row = ruleToRowState(rule,'org')
   expect(row.audienceMode).toBe(auth === 'public' || audience === null ? 'inherit' : audience === 'org' ? 'any_org_role' : 'any_authenticated')
   expect(rowStateToRule({...row,path:'/other'})).toEqual({...rule,path:'/other'})
  }
  for (const authAudience of ['org','any'] as const) {
   const app = {authMode:'platform' as const,authScope:'all' as const,authAudience,authRules:[{path:'/',auth:'required',roles:null,audience:null} as unknown as AppAuthRule]}
   expect(summarizeAppAuthBaseline(app).roleCodes).toEqual(authAudience === 'org' ? null : [])
  }
 })
 it('preserves duplicate roots and first-winner semantics on unrelated edits', () => {
  for (const secondAuth of ['public','required'] as const) for (const authScope of ['all','paths'] as const) for (const auth of ['public','required'] as const) for (const path of ['/','/ ','///']) {
   const first = {path,auth,roles:['reviewer']}
   const app = {authScope,authAudience:'org' as const,authRules:[first,{path:'/',auth:secondAuth,roles:['admin']},{path:'/staff',auth:'required' as const}]}
   const baseline = baselineToRowState(app)
   expect(baseline.originalRule).toEqual(first)
   expect(baseline.requiresLogin).toBe(auth === 'required')
   const rows = exceptionRulesToRowState(app)
   expect(rows).toHaveLength(2)
   rows[1].path='/other'
   expect(buildAuthPolicyPatch(baseline,rows,app)).toEqual({...app,authRules:[first,app.authRules[1],{path:'/other',auth:'required'}]})
   expect(summarizeAppAuthBaseline({...app,authMode:'platform'})).toEqual({requiresLogin:auth === 'required',roleCodes:auth === 'required' ? ['reviewer'] : []})
  }
 })
})
