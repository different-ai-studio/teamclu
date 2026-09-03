import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { shellOpenMock } = vi.hoisted(() => ({ shellOpenMock: vi.fn() }))

vi.mock('@tauri-apps/plugin-shell', () => ({
  open: (...args: unknown[]) => shellOpenMock(...args),
}))

import { isAllowedExternalUrl, openExternalUrl } from '@/lib/utils'

type TauriWindow = Window & { __TAURI__?: unknown }

describe('openExternalUrl (SEC-11)', () => {
  let windowOpen: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    shellOpenMock.mockReset().mockResolvedValue(undefined)
    windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    delete (window as TauriWindow).__TAURI__
    vi.restoreAllMocks()
  })

  it('allows only http(s) and mailto', () => {
    expect(isAllowedExternalUrl('https://example.com/x')).toBe(true)
    expect(isAllowedExternalUrl('http://example.com')).toBe(true)
    expect(isAllowedExternalUrl('mailto:someone@example.com')).toBe(true)
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedExternalUrl('teamclu://invite?token=x')).toBe(false)
    expect(isAllowedExternalUrl('not a url')).toBe(false)
  })

  it('refuses javascript: and file: URLs without opening anything', async () => {
    ;(window as TauriWindow).__TAURI__ = {}
    await openExternalUrl('javascript:alert(1)')
    await openExternalUrl('file:///etc/passwd')
    expect(shellOpenMock).not.toHaveBeenCalled()
    expect(windowOpen).not.toHaveBeenCalled()
  })

  it('opens an allowed URL through the shell plugin under Tauri', async () => {
    ;(window as TauriWindow).__TAURI__ = {}
    await openExternalUrl('https://example.com/docs')
    expect(shellOpenMock).toHaveBeenCalledWith('https://example.com/docs')
    expect(windowOpen).not.toHaveBeenCalled()
  })

  it('does not fall back to window.open when shell.open fails under Tauri', async () => {
    ;(window as TauriWindow).__TAURI__ = {}
    shellOpenMock.mockRejectedValue(new Error('denied'))
    await openExternalUrl('https://example.com/docs')
    expect(windowOpen).not.toHaveBeenCalled()
  })

  it('uses a no-opener window.open outside Tauri', async () => {
    await openExternalUrl('https://example.com/docs')
    expect(shellOpenMock).not.toHaveBeenCalled()
    expect(windowOpen).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener,noreferrer')
  })
})
