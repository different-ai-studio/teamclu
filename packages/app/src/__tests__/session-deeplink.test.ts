import { describe, it, expect, afterEach, vi } from 'vitest'
import { parseSessionDeeplink, buildSessionDeeplink } from '@/lib/session/session-deeplink'

const UUID = 'a1ca8f06-94ee-4fb5-bdfb-194a5606062f'

describe('parseSessionDeeplink', () => {
  it('extracts the uuid from teamclu://session/<uuid>', () => {
    expect(parseSessionDeeplink(`teamclu://session/${UUID}`)).toBe(UUID)
  })

  it('also accepts amux://session/<uuid> for back-compat', () => {
    expect(parseSessionDeeplink(`amux://session/${UUID}`)).toBe(UUID)
  })

  it('returns null for invite urls', () => {
    expect(parseSessionDeeplink('teamclu://invite?token=ABC')).toBeNull()
  })

  it('returns null when the path is not a uuid', () => {
    expect(parseSessionDeeplink('teamclu://session/not-a-uuid')).toBeNull()
  })

  it('returns null when the session id is missing', () => {
    expect(parseSessionDeeplink('teamclu://session')).toBeNull()
    expect(parseSessionDeeplink('teamclu://session/')).toBeNull()
  })

  it('returns null for malformed urls', () => {
    expect(parseSessionDeeplink('not a url')).toBeNull()
  })
})

describe('buildSessionDeeplink', () => {
  it('builds teamclu://session/<uuid> using the build scheme', () => {
    expect(buildSessionDeeplink(UUID)).toBe(`teamclu://session/${UUID}`)
  })
})

describe('a build with its own app.scheme', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/config/build-config')
    vi.resetModules()
  })

  it('takes copilot361:// and nothing else', async () => {
    vi.resetModules()
    vi.doMock('@/lib/config/build-config', async () => {
      const actual =
        await vi.importActual<typeof import('@/lib/config/build-config')>('@/lib/config/build-config')
      return {
        ...actual,
        appScheme: 'copilot361',
        deeplinkSchemes: actual.resolveDeeplinkSchemes('copilot361'),
      }
    })
    const mod = await import('@/lib/session/session-deeplink')
    expect(mod.parseSessionDeeplink(`copilot361://session/${UUID}`)).toBe(UUID)
    expect(mod.parseSessionDeeplink(`teamclu://session/${UUID}`)).toBeNull()
    expect(mod.parseSessionDeeplink(`amux://session/${UUID}`)).toBeNull()
    expect(mod.buildSessionDeeplink(UUID)).toBe(`copilot361://session/${UUID}`)
  })
})
