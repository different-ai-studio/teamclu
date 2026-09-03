import { describe, it, expect, vi, afterEach } from 'vitest'
import { formatPageContext, startEmbedPageContextListener, requestPageCapture, consumePendingLinkContext } from '@/lib/embed/embed-page-context'
import * as bus from '@/lib/embed/embed-composer-bus'

afterEach(() => { vi.restoreAllMocks(); delete (globalThis as Record<string, unknown>).chrome })

describe('formatPageContext', () => {
  it('prefers selection over full text and includes title+url', () => {
    const out = formatPageContext({ title: 'T', url: 'https://x', text: 'BODY', selection: 'SEL' })
    expect(out).toContain('SEL')
    expect(out).toContain('https://x')
    expect(out).not.toContain('BODY')
  })
  it('falls back to full text when no selection', () => {
    const out = formatPageContext({ title: 'T', url: 'https://x', text: 'BODY', selection: '' })
    expect(out).toContain('BODY')
  })
})

describe('requestPageCapture', () => {
  it('resolves without throwing when sendMessage is absent', async () => {
    await expect(requestPageCapture()).resolves.toBeUndefined()
  })
  it('emits composer insert when sendMessage resolves a valid page-context', async () => {
    const spy = vi.spyOn(bus, 'emitComposerInsert')
    ;(globalThis as Record<string, unknown>).chrome = {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({
          type: 'page-context',
          payload: { title: 'MyPage', url: 'https://example.com', text: 'body', selection: 'selected' },
        }),
      },
    }
    await requestPageCapture()
    expect(spy).toHaveBeenCalledOnce()
    expect(spy.mock.calls[0][0]).toContain('selected')
    expect(spy.mock.calls[0][0]).toContain('https://example.com')
  })
  it('resolves without throwing when sendMessage rejects', async () => {
    const spy = vi.spyOn(bus, 'emitComposerInsert')
    ;(globalThis as Record<string, unknown>).chrome = {
      runtime: {
        sendMessage: vi.fn().mockRejectedValue(new Error('extension error')),
      },
    }
    await expect(requestPageCapture()).resolves.toBeUndefined()
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('consumePendingLinkContext', () => {
  it('is a no-op when session storage is absent', async () => {
    const spy = vi.spyOn(bus, 'emitComposerInsert')
    await consumePendingLinkContext()
    expect(spy).not.toHaveBeenCalled()
  })

  it('injects and clears a pending link payload', async () => {
    const spy = vi.spyOn(bus, 'emitComposerInsert')
    const remove = vi.fn().mockResolvedValue(undefined)
    ;(globalThis as Record<string, unknown>).chrome = {
      storage: {
        session: {
          get: vi.fn().mockResolvedValue({
            'teamclu.pendingLinkContext': {
              title: 'Page',
              url: 'https://example.com/doc',
              text: 'Read me',
              selection: 'Read me',
            },
          }),
          remove,
        },
      },
    }
    await consumePendingLinkContext()
    expect(spy).toHaveBeenCalledOnce()
    expect(spy.mock.calls[0][0]).toContain('https://example.com/doc')
    expect(remove).toHaveBeenCalledWith('teamclu.pendingLinkContext')
  })
})

describe('startEmbedPageContextListener', () => {
  it('is a no-op (returns cleanup) when chrome is absent', () => {
    const off = startEmbedPageContextListener()
    expect(typeof off).toBe('function')
    off()
  })
  it('emits composer insert when a page-context message arrives', () => {
    let handler: ((m: unknown) => void) | null = null
    ;(globalThis as Record<string, unknown>).chrome = {
      runtime: {
        onMessage: {
          addListener: (h: (m: unknown) => void) => { handler = h },
          removeListener: () => {},
        },
      },
    }
    const spy = vi.spyOn(bus, 'emitComposerInsert')
    const off = startEmbedPageContextListener()
    handler!({ type: 'page-context', payload: { title: 'T', url: 'u', text: 'B', selection: 'S' } })
    expect(spy).toHaveBeenCalledOnce()
    expect(spy.mock.calls[0][0]).toContain('S')
    off()
  })
})
