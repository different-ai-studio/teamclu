import { afterEach, describe, expect, it, vi } from 'vitest'

import { formatShortcut, terminalToggleShortcutLabel } from '@/lib/platform-shortcuts'

describe('formatShortcut', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses ⌘ on macOS', () => {
    vi.stubGlobal('navigator', {
      platform: 'MacIntel',
      userAgent: 'Macintosh',
    })
    expect(formatShortcut('mod+K')).toBe('⌘K')
    expect(formatShortcut('mod+N')).toBe('⌘N')
    expect(formatShortcut('mod+enter')).toBe('⌘↵')
  })

  it('uses Ctrl on Windows', () => {
    vi.stubGlobal('navigator', {
      platform: 'Win32',
      userAgent: 'Windows NT 10.0',
    })
    expect(formatShortcut('mod+K')).toBe('Ctrl+K')
    expect(formatShortcut('mod+N')).toBe('Ctrl+N')
    expect(formatShortcut('mod+enter')).toBe('Ctrl+↵')
  })

  it('terminal toggle label differs by platform', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Macintosh' })
    expect(terminalToggleShortcutLabel()).toBe('⌃`')

    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: 'Windows NT 10.0' })
    expect(terminalToggleShortcutLabel()).toBe('Ctrl+`')
  })
})
