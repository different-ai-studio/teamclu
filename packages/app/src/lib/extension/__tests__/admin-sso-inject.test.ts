import { beforeEach, describe, expect, it, vi } from 'vitest'

const { targetMock, sessionMock, openTabMock } = vi.hoisted(() => ({
  targetMock: vi.fn(),
  sessionMock: vi.fn(),
  openTabMock: vi.fn(),
}))

vi.mock('@/lib/auth/web-sso', () => ({
  adminConsoleTarget: () => targetMock(),
}))
vi.mock('@/lib/auth/session-store', () => ({
  getSession: () => sessionMock(),
}))
vi.mock('@/stores/tabs', () => ({
  useTabsStore: { getState: () => ({ openTab: openTabMock }) },
}))

import {
  adminSsoInjectionFor,
  openAdminConsoleTab,
  resetAdminSsoEntriesForTests,
} from '@/lib/extension/admin-sso-inject'

const TARGET = {
  loginUrl: 'https://admin.example.test/sign-in',
  host: 'admin.example.test',
  storageKey: 'sb-test-auth-token',
}
const SESSION = {
  access_token: 'access-abc',
  refresh_token: 'refresh-def',
  expires_at: 1234,
  expires_in: 3600,
  token_type: 'bearer',
  user: { id: 'u1' },
}

beforeEach(() => {
  resetAdminSsoEntriesForTests()
  targetMock.mockReset().mockReturnValue(TARGET)
  sessionMock.mockReset().mockReturnValue(SESSION)
  openTabMock.mockReset()
})

describe('adminSsoInjectionFor (SEC-5)', () => {
  it('never injects for a URL that was not opened through the explicit entry', () => {
    // A link in agent markdown or a teammate's message pointing at the admin
    // host — even the login page itself — opens as a plain webview.
    expect(adminSsoInjectionFor('https://admin.example.test/sign-in')).toBeNull()
    expect(adminSsoInjectionFor('https://admin.example.test/anything?x=1')).toBeNull()
    expect(adminSsoInjectionFor('admin.example.test')).toBeNull()
  })

  it('injects for the login URL after the explicit entry opened it', () => {
    expect(openAdminConsoleTab()).toBe(true)
    expect(openTabMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'webview', target: TARGET.loginUrl }),
    )
    const injection = adminSsoInjectionFor(TARGET.loginUrl)
    expect(injection?.storageKey).toBe(TARGET.storageKey)
    const parsed = JSON.parse(injection!.sessionJson)
    expect(parsed.access_token).toBe('access-abc')
    expect(parsed.refresh_token).toBe('refresh-def')
  })

  it('matches the explicit entry after WebViewContent-style normalization (fragment dropped)', () => {
    openAdminConsoleTab()
    expect(adminSsoInjectionFor('https://admin.example.test/sign-in#top')).not.toBeNull()
  })

  it('does not inject on another path of the admin host, even after an explicit entry', () => {
    openAdminConsoleTab()
    expect(adminSsoInjectionFor('https://admin.example.test/settings')).toBeNull()
    expect(adminSsoInjectionFor('https://admin.example.test/sign-in/../settings')).toBeNull()
  })

  it('does not inject when the login URL is on a different host than expected', () => {
    openAdminConsoleTab()
    expect(adminSsoInjectionFor('https://evil.example.test/sign-in')).toBeNull()
  })

  it('needs a full session with a refresh token', () => {
    openAdminConsoleTab()
    sessionMock.mockReturnValue({ ...SESSION, refresh_token: undefined })
    expect(adminSsoInjectionFor(TARGET.loginUrl)).toBeNull()
  })

  it('openAdminConsoleTab is a no-op without a configured admin console', () => {
    targetMock.mockReturnValue(null)
    expect(openAdminConsoleTab()).toBe(false)
    expect(openTabMock).not.toHaveBeenCalled()
  })
})
