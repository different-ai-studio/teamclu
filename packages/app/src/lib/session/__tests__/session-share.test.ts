import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

import { canSystemShare, isShareCancelled, systemShareText } from '@/lib/session/session-share'

type TauriWindow = Window & { __TAURI__?: unknown }
type ShareCapableNavigator = Navigator & { share?: (data: ShareData) => Promise<void> }

function setPlatform(platform: string, userAgent: string) {
  Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true })
  Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, configurable: true })
}

const MAC = ['MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'] as const
const WIN = ['Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'] as const

describe('session share', () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue(undefined)
    setPlatform(...MAC)
  })

  afterEach(() => {
    delete (window as TauriWindow).__TAURI__
    delete (window.navigator as ShareCapableNavigator).share
  })

  describe('canSystemShare', () => {
    it('is on in the desktop app on macOS', () => {
      ;(window as TauriWindow).__TAURI__ = {}
      expect(canSystemShare()).toBe(true)
    })

    // NSSharingServicePicker has no Windows counterpart wired up, so the menu
    // entry has to stay hidden there rather than fail on click.
    it('is off in the desktop app on Windows', () => {
      ;(window as TauriWindow).__TAURI__ = {}
      setPlatform(...WIN)
      expect(canSystemShare()).toBe(false)
    })

    it('outside Tauri follows the Web Share API', () => {
      expect(canSystemShare()).toBe(false)
      ;(window.navigator as ShareCapableNavigator).share = vi.fn(async () => {})
      expect(canSystemShare()).toBe(true)
    })
  })

  describe('systemShareText', () => {
    it('calls the native command with the anchor rect', async () => {
      ;(window as TauriWindow).__TAURI__ = {}
      const anchor = { x: 12, y: 34, width: 20, height: 20 }
      await systemShareText('teamclu://session/abc', anchor)
      expect(invokeMock).toHaveBeenCalledWith('system_share_text', {
        text: 'teamclu://session/abc',
        anchor,
      })
    })

    it('sends a null anchor when there is nothing to hang the sheet from', async () => {
      ;(window as TauriWindow).__TAURI__ = {}
      await systemShareText('teamclu://session/abc')
      expect(invokeMock).toHaveBeenCalledWith('system_share_text', {
        text: 'teamclu://session/abc',
        anchor: null,
      })
    })

    it('falls back to the Web Share API outside Tauri', async () => {
      const share = vi.fn(async () => {})
      ;(window.navigator as ShareCapableNavigator).share = share
      await systemShareText('teamclu://session/abc')
      expect(share).toHaveBeenCalledWith({ text: 'teamclu://session/abc' })
      expect(invokeMock).not.toHaveBeenCalled()
    })

    it('rejects when no share sheet exists at all', async () => {
      await expect(systemShareText('teamclu://session/abc')).rejects.toThrow(/unavailable/)
    })
  })

  describe('isShareCancelled', () => {
    it('recognises the user backing out of the sheet', () => {
      const abort = new Error('cancelled')
      abort.name = 'AbortError'
      expect(isShareCancelled(abort)).toBe(true)
      expect(isShareCancelled(new Error('boom'))).toBe(false)
      expect(isShareCancelled('boom')).toBe(false)
    })
  })
})
