import { describe, expect, it } from 'vitest'
import {
  baselineToRowState,
  buildAuthPolicyPatch,
  exceptionRulesToRowState,
  formatAppAuthAccessSummary,
  ruleToRowState,
  summarizeAppAuthBaseline,
} from '../app-auth-access'
import type { AppRow } from '@/lib/backend/types'

const ALL = ['admin', 'finance', 'member']

describe('app-auth-access', () => {
  it('maps public / roles / legacy audience into row state', () => {
    expect(ruleToRowState({ path: '/x', auth: 'public' }, 'org', ALL)).toEqual({
      path: '/x',
      requiresLogin: false,
      roleCodes: [],
    })
    expect(
      ruleToRowState({ path: '/x', auth: 'required', roles: ['admin'] }, 'org', ALL),
    ).toEqual({ path: '/x', requiresLogin: true, roleCodes: ['admin'] })
    expect(ruleToRowState({ path: '/x', auth: 'required' }, 'any', ALL)).toEqual({
      path: '/x',
      requiresLogin: true,
      roleCodes: [],
    })
    expect(ruleToRowState({ path: '/x', auth: 'required' }, 'org', ALL).roleCodes).toEqual(ALL)
  })

  it('encodes baseline login as / with roles on save', () => {
    expect(
      buildAuthPolicyPatch(
        { path: '/', requiresLogin: true, roleCodes: ['admin', 'finance'] },
        [{ path: '/health', requiresLogin: false, roleCodes: [] }],
      ),
    ).toEqual({
      // 'org', not 'any': auth_audience is the gateway's last-resort answer for
      // a path whose own verdict cannot be read, and this policy restricts
      // roles. Writing 'any' made that fallback admit every signed-in visitor.
      authAudience: 'org',
      authScope: 'all',
      authRules: [
        { path: '/', auth: 'required', roles: ['admin', 'finance'] },
        { path: '/health', auth: 'public' },
      ],
    })
  })

  it("keeps the fallback audience 'any' only when nothing restricts anybody", () => {
    expect(
      buildAuthPolicyPatch({ path: '/', requiresLogin: true, roleCodes: [] }, []).authAudience,
    ).toBe('any')
    // A public baseline whose exceptions still name roles must not advertise
    // 'any' either — the exceptions are what the fallback would answer for.
    expect(
      buildAuthPolicyPatch({ path: '/', requiresLogin: false, roleCodes: [] }, [
        { path: '/admin', requiresLogin: true, roleCodes: ['admin'] },
      ]).authAudience,
    ).toBe('org')
  })

  it('loads a / roles rule as baseline and drops it from exceptions', () => {
    const app = {
      authScope: 'all',
      authAudience: 'any',
      authRules: [
        { path: '/', auth: 'required', roles: ['admin'] },
        { path: '/admin', auth: 'required', roles: ['admin'] },
      ],
    } as Pick<AppRow, 'authScope' | 'authAudience' | 'authRules'>
    expect(baselineToRowState(app, ALL)).toEqual({
      path: '/',
      requiresLogin: true,
      roleCodes: ['admin'],
    })
    expect(exceptionRulesToRowState(app, ALL)).toEqual([
      { path: '/admin', requiresLogin: true, roleCodes: ['admin'] },
    ])
  })

  it('formats summary copy', () => {
    expect(formatAppAuthAccessSummary({ requiresLogin: false, roleCodes: [] })).toBe('不需要登录')
    expect(formatAppAuthAccessSummary({ requiresLogin: true, roleCodes: [] })).toBe(
      '需要登录 · 任意用户',
    )
    expect(
      formatAppAuthAccessSummary({ requiresLogin: true, roleCodes: ['admin', 'finance'] }),
    ).toBe('需要登录 · admin, finance')
    expect(
      formatAppAuthAccessSummary(
        summarizeAppAuthBaseline({
          authMode: 'platform',
          authScope: 'all',
          authAudience: 'org',
          authRules: [],
        }),
      ),
    ).toBe('需要登录 · 组织角色')
  })
})
