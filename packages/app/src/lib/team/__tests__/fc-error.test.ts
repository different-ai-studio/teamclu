import { describe, it, expect } from 'vitest'
import { humanizeFcError, isNotLoggedInError } from '@/lib/team/fc-error'

describe('fc-error', () => {
  it('detects the not-logged-in / missing-jwt error', () => {
    expect(isNotLoggedInError('supabase_jwt not found — user not logged in')).toBe(true)
    expect(isNotLoggedInError(new Error('user not logged in'))).toBe(true)
    expect(isNotLoggedInError('some other failure')).toBe(false)
  })

  it('maps the not-logged-in error to friendly copy', () => {
    expect(humanizeFcError('supabase_jwt not found — user not logged in')).toBe(
      '请先登录后再操作。',
    )
  })

  it('maps FC schema_drift / PGRST202 errors to the schema-drift copy', () => {
    const expected = 'Cloud API 与数据库结构版本不一致。请部署最新的 Cloud API 与 Supabase 迁移后重试。'
    expect(humanizeFcError(new Error('500 schema_drift: missing fn'))).toBe(expected)
    expect(humanizeFcError('PGRST202 Could not find the function')).toBe(expected)
  })

  it('passes through other errors unchanged', () => {
    expect(humanizeFcError(new Error('network timeout'))).toBe('network timeout')
    expect(humanizeFcError('boom')).toBe('boom')
  })
})
