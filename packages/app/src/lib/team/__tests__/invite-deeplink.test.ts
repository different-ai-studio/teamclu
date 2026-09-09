import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/config/build-config', () => ({ appScheme: 'teamclu' }))

import { buildInviteDeeplink, parseInviteDeeplink, parseInviteInput } from '../invite-deeplink'

describe('buildInviteDeeplink', () => {
  it('carries the inviter endpoint so the invitee never types an address', () => {
    expect(buildInviteDeeplink('tok-1', 'https://api.acme.test')).toBe(
      'teamclu://invite?token=tok-1&cloud_api_url=https%3A%2F%2Fapi.acme.test',
    )
  })

  it('omits the parameter when the inviter has no endpoint resolved', () => {
    expect(buildInviteDeeplink('tok-1')).toBe('teamclu://invite?token=tok-1')
    expect(buildInviteDeeplink('tok-1', null)).toBe('teamclu://invite?token=tok-1')
  })

  it('round-trips a token that needs escaping', () => {
    const link = buildInviteDeeplink('a+b/c=', 'https://api.acme.test')
    expect(parseInviteInput(link)).toEqual({
      token: 'a+b/c=',
      cloudApiUrl: 'https://api.acme.test',
    })
  })
})

describe('parseInviteInput', () => {
  it('reads the endpoint off a pasted link', () => {
    expect(
      parseInviteInput('teamclu://invite?token=tok-1&cloud_api_url=https%3A%2F%2Fapi.acme.test'),
    ).toEqual({ token: 'tok-1', cloudApiUrl: 'https://api.acme.test' })
  })

  it('accepts the amux scheme the RPC still emits', () => {
    expect(parseInviteInput('amux://invite?token=tok-1')).toEqual({
      token: 'tok-1',
      cloudApiUrl: null,
    })
  })

  it('treats a bare token as naming no server', () => {
    expect(parseInviteInput('  tok-1  ')).toEqual({ token: 'tok-1', cloudApiUrl: null })
  })

  it('reports an empty cloud_api_url as absent rather than as an empty address', () => {
    expect(parseInviteInput('teamclu://invite?token=tok-1&cloud_api_url=')).toEqual({
      token: 'tok-1',
      cloudApiUrl: null,
    })
  })

  it('rejects anything else carrying a scheme', () => {
    expect(parseInviteInput('https://example.com/invite?token=tok-1')).toBeNull()
    expect(parseInviteInput('teamclu://team?token=tok-1')).toBeNull()
    expect(parseInviteInput('teamclu://invite?token=')).toBeNull()
    expect(parseInviteInput('   ')).toBeNull()
  })
})

describe('parseInviteDeeplink', () => {
  // SEC-3: the OS hands this build links on its own scheme only.
  it('takes the app scheme and nothing else', () => {
    expect(parseInviteDeeplink('teamclu://invite?token=tok-1')).toBe('tok-1')
    expect(parseInviteDeeplink('amux://invite?token=tok-1')).toBeNull()
  })
})
