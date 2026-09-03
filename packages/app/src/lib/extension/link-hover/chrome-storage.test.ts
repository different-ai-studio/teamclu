import { beforeEach, describe, expect, it, vi } from 'vitest'

const storageState = vi.hoisted(() => ({
  bag: {} as Record<string, unknown>,
}))

const bakeState = vi.hoisted(() => ({
  linkHover: {
    domains: [] as string[],
    urlPatterns: [] as string[],
  },
}))

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(async (keys: string | string[]) => {
        const key = Array.isArray(keys) ? keys[0]! : keys
        return key in storageState.bag ? { [key]: storageState.bag[key] } : {}
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(storageState.bag, items)
      }),
    },
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
})

vi.mock('../extension-settings-bake', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../extension-settings-bake')>()
  return {
    ...actual,
    parseExtensionSettingsBake: () => ({
      hideButton: false,
      linkHover: {
        domains: [...bakeState.linkHover.domains],
        urlPatterns: [...bakeState.linkHover.urlPatterns],
      },
    }),
  }
})

describe('readLinkHoverConfig bake seed', () => {
  beforeEach(() => {
    storageState.bag = {}
    bakeState.linkHover = { domains: [], urlPatterns: [] }
    vi.resetModules()
  })

  it('seeds chrome.storage from baked defaults when unset', async () => {
    bakeState.linkHover = {
      domains: ['example.com'],
      urlPatterns: ['*/example/*'],
    }
    const mod = await import('./chrome-storage')

    const config = await mod.readLinkHoverConfig()
    expect(config).toEqual({
      domains: ['example.com'],
      urlPatterns: ['*/example/*'],
    })
    expect(storageState.bag['teamclu.extension.linkHover']).toEqual({
      domains: ['example.com'],
      urlPatterns: ['*/example/*'],
    })
  })

  it('returns existing chrome.storage value without reseeding', async () => {
    bakeState.linkHover = {
      domains: ['baked.example.com'],
      urlPatterns: ['*/baked/*'],
    }
    storageState.bag['teamclu.extension.linkHover'] = {
      domains: ['example.com'],
      urlPatterns: ['*/other/*'],
    }
    const mod = await import('./chrome-storage')

    const config = await mod.readLinkHoverConfig()
    expect(config).toEqual({
      domains: ['example.com'],
      urlPatterns: ['*/other/*'],
    })
  })

  it('fills baked urlPatterns when legacy storage only has domains', async () => {
    bakeState.linkHover = {
      domains: ['baked.example.com'],
      urlPatterns: ['*/example/*'],
    }
    storageState.bag['teamclu.extension.linkHover'] = {
      domains: ['example.com'],
    }
    const mod = await import('./chrome-storage')

    const config = await mod.readLinkHoverConfig()
    expect(config).toEqual({
      domains: ['example.com'],
      urlPatterns: ['*/example/*'],
    })
    expect(storageState.bag['teamclu.extension.linkHover']).toEqual({
      domains: ['example.com'],
      urlPatterns: ['*/example/*'],
    })
  })

  it('does not overwrite an explicit empty urlPatterns list', async () => {
    bakeState.linkHover = {
      domains: ['baked.example.com'],
      urlPatterns: ['*/example/*'],
    }
    storageState.bag['teamclu.extension.linkHover'] = {
      domains: ['example.com'],
      urlPatterns: [],
    }
    const mod = await import('./chrome-storage')

    const config = await mod.readLinkHoverConfig()
    expect(config).toEqual({
      domains: ['example.com'],
      urlPatterns: [],
    })
  })
})
