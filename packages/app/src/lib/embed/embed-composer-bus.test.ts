import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PageContext } from '@/lib/embed/embed-page-context'
import {
  emitComposerInsert,
  emitPageLinkInsert,
  subscribeComposerInsert,
} from '@/lib/embed/embed-composer-bus'

const requestPageLinkInsert = vi.fn()

vi.mock('@/stores/ui', () => ({
  useUIStore: {
    getState: () => ({ requestPageLinkInsert }),
  },
}))

describe('embed-composer-bus', () => {
  beforeEach(() => {
    requestPageLinkInsert.mockClear()
  })

  it('delivers emitted text to subscribers', () => {
    const seen: string[] = []
    const off = subscribeComposerInsert((t) => seen.push(t))
    emitComposerInsert('hello')
    emitComposerInsert('world')
    expect(seen).toEqual(['hello', 'world'])
    off()
  })

  it('stops delivery after unsubscribe', () => {
    const fn = vi.fn()
    const off = subscribeComposerInsert(fn)
    off()
    emitComposerInsert('x')
    expect(fn).not.toHaveBeenCalled()
  })

  it('queues page-link inserts via ui store', () => {
    const ctx: PageContext = { title: 'T', url: 'u', text: 'b', selection: 's' }
    emitPageLinkInsert(ctx)
    expect(requestPageLinkInsert).toHaveBeenCalledWith(ctx)
  })
})
