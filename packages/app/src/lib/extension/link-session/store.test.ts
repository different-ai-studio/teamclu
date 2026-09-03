import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildLinkSessionCompositeKey } from './key'
import {
  clearLinkSessionMap,
  clearLinkSessionMapForTeam,
  lookupLinkSessionEntry,
  readLinkSessionMap,
  removeLinkSessionEntriesForSession,
  upsertLinkSessionEntry,
} from './store'

type StorageBag = Record<string, unknown>

function installChromeStorage(initial: StorageBag = {}) {
  const bag: StorageBag = { ...initial }
  const chrome = {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          if (typeof keys === 'string') {
            return { [keys]: bag[keys] }
          }
          const out: StorageBag = {}
          for (const key of keys) out[key] = bag[key]
          return out
        }),
        set: vi.fn(async (items: StorageBag) => {
          Object.assign(bag, items)
        }),
      },
    },
  }
  vi.stubGlobal('chrome', chrome)
  return bag
}

describe('link session store', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('upserts and reads entry by composite key', async () => {
    installChromeStorage()
    await upsertLinkSessionEntry({
      teamId: 't1',
      linkKey: 'https://a.com',
      sessionId: 's1',
      linkText: 'Item',
    })
    const hit = await lookupLinkSessionEntry('t1', 'https://a.com')
    expect(hit?.sessionId).toBe('s1')
    expect(hit?.linkText).toBe('Item')
  })

  it('clearLinkSessionMap removes all entries', async () => {
    installChromeStorage()
    await upsertLinkSessionEntry({
      teamId: 't1',
      linkKey: 'https://a.com',
      sessionId: 's1',
      linkText: 'Item',
    })
    await clearLinkSessionMap()
    expect(await lookupLinkSessionEntry('t1', 'https://a.com')).toBeNull()
  })

  it('clearLinkSessionMapForTeam removes only matching team', async () => {
    installChromeStorage()
    await upsertLinkSessionEntry({
      teamId: 't1',
      linkKey: 'https://a.com/item-1',
      sessionId: 's1',
      linkText: 'A',
    })
    await upsertLinkSessionEntry({
      teamId: 't2',
      linkKey: 'https://b.com/item-2',
      sessionId: 's2',
      linkText: 'B',
    })
    await clearLinkSessionMapForTeam('t1')
    const afterClear = await readLinkSessionMap()
    expect(await lookupLinkSessionEntry('t1', 'https://a.com/item-1')).toBeNull()
    const t2Key = buildLinkSessionCompositeKey('t2', 'https://b.com/item-2')
    expect(afterClear.entries[t2Key]?.sessionId).toBe('s2')
  })

  it('removeLinkSessionEntriesForSession drops mappings for that session only', async () => {
    installChromeStorage()
    await upsertLinkSessionEntry({
      teamId: 't1',
      linkKey: 'https://a.com/one',
      sessionId: 's-delete',
      linkText: 'One',
    })
    await upsertLinkSessionEntry({
      teamId: 't1',
      linkKey: 'https://a.com/two',
      sessionId: 's-keep',
      linkText: 'Two',
    })
    await removeLinkSessionEntriesForSession('s-delete')
    expect(await lookupLinkSessionEntry('t1', 'https://a.com/one')).toBeNull()
    expect((await lookupLinkSessionEntry('t1', 'https://a.com/two'))?.sessionId).toBe('s-keep')
  })
})
