import { describe, it, expect, afterEach, vi } from 'vitest'
import { buildInviteDeeplink, parseInviteDeeplink, parseInviteTokenInput } from '@/lib/invite-deeplink'

describe('parseInviteDeeplink', () => {
  it('extracts the token from teamclu://invite?token=…', () => {
    expect(parseInviteDeeplink('teamclu://invite?token=ABCXYZ_24bytes')).toBe('ABCXYZ_24bytes')
  })

  it('rejects the pre-rebrand teamclaw:// scheme (SEC-3)', () => {
    // No build registers it with the OS any more, so the only way such a URL
    // reaches the parser is something other than a real deep link.
    expect(parseInviteDeeplink('teamclaw://invite?token=OLD_LINK')).toBeNull()
  })

  it('rejects amux:// as a deep link (SEC-3)', () => {
    // The RPC still emits it, but the OS never delivers it — tauri.conf.json
    // registers exactly the build scheme. Pasted input accepts it (below).
    expect(parseInviteDeeplink('amux://invite?token=XYZ')).toBeNull()
  })

  it('returns null for non-invite paths', () => {
    expect(parseInviteDeeplink('teamclu://session/123')).toBeNull()
  })

  it('returns null when token query is absent', () => {
    expect(parseInviteDeeplink('teamclu://invite')).toBeNull()
  })

  it('returns null for malformed urls', () => {
    expect(parseInviteDeeplink('not a url')).toBeNull()
  })
})

describe('parseInviteTokenInput', () => {
  it('accepts bare invite tokens for pasted onboarding input', () => {
    expect(parseInviteTokenInput('  bare_token_123  ')).toBe('bare_token_123')
  })

  it('accepts deeplinks for pasted onboarding input', () => {
    expect(parseInviteTokenInput('teamclu://invite?token=FROM_LINK')).toBe('FROM_LINK')
  })

  it('still accepts the amux:// link the create-invite RPC emits when pasted', () => {
    expect(parseInviteTokenInput('amux://invite?token=XYZ')).toBe('XYZ')
  })

  it('rejects a pasted pre-rebrand teamclaw:// link', () => {
    expect(parseInviteTokenInput('teamclaw://invite?token=OLD')).toBeNull()
  })

  it('rejects non-invite urls for pasted onboarding input', () => {
    expect(parseInviteTokenInput('https://example.com/invite?token=nope')).toBeNull()
  })
})

describe('buildInviteDeeplink', () => {
  it('builds the link on the build scheme, not the backend amux:// one', () => {
    expect(buildInviteDeeplink('TOK/EN+1')).toBe('teamclu://invite?token=TOK%2FEN%2B1')
  })
})

describe('a build with its own app.scheme', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/build-config')
    vi.resetModules()
  })

  async function loadForScheme(scheme: string) {
    vi.resetModules()
    vi.doMock('@/lib/build-config', async () => {
      const actual =
        await vi.importActual<typeof import('@/lib/build-config')>('@/lib/build-config')
      return { ...actual, appScheme: scheme }
    })
    return import('@/lib/invite-deeplink')
  }

  it('takes copilot361:// and nothing else', async () => {
    // The OS only ever hands this build copilot361:// links; a teamclu:// or
    // amux:// one would open the official app, so accepting it here just made a
    // dead link look supported.
    const { parseInviteDeeplink: parse } = await loadForScheme('copilot361')
    expect(parse('copilot361://invite?token=OK')).toBe('OK')
    expect(parse('teamclu://invite?token=NO')).toBeNull()
    expect(parse('teamclaw://invite?token=NO')).toBeNull()
    expect(parse('amux://invite?token=NO')).toBeNull()
  })

  it('hands out invite links on its own scheme', async () => {
    const { buildInviteDeeplink: build } = await loadForScheme('copilot361')
    expect(build('TOK')).toBe('copilot361://invite?token=TOK')
  })

  it('still takes a bare pasted token and a pasted amux:// link', async () => {
    const { parseInviteTokenInput: parseInput } = await loadForScheme('copilot361')
    expect(parseInput('  bare_token_123  ')).toBe('bare_token_123')
    expect(parseInput('amux://invite?token=RPC')).toBe('RPC')
    expect(parseInput('teamclu://invite?token=OTHER_BRAND')).toBeNull()
  })
})
