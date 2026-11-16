import { describe, expect, it } from 'vitest'
import { resolveControlPanelAppId } from '@/lib/apps/app-control-panel'

describe('resolveControlPanelAppId', () => {
  it("shows the app the open session belongs to", () => {
    expect(
      resolveControlPanelAppId({
        activeSessionId: 'sess-1',
        sessionAppId: 'app-a',
        appIdBySessionId: {},
      }),
    ).toBe('app-a')
  })

  it("prefers the session's own app_id over the in-memory map", () => {
    expect(
      resolveControlPanelAppId({
        activeSessionId: 'sess-1',
        sessionAppId: 'app-a',
        appIdBySessionId: { 'sess-1': 'app-b' },
      }),
    ).toBe('app-a')
  })

  it('falls back to the map for a session opened from the apps section before its row landed', () => {
    expect(
      resolveControlPanelAppId({
        activeSessionId: 'sess-2',
        sessionAppId: null,
        appIdBySessionId: { 'sess-2': 'app-c' },
      }),
    ).toBe('app-c')
  })

  it('shows nothing for a chat session with no app', () => {
    expect(
      resolveControlPanelAppId({
        activeSessionId: 'chat-1',
        sessionAppId: null,
        appIdBySessionId: { 'other-sess': 'app-a' },
      }),
    ).toBeNull()
  })

  it('shows nothing with no session open', () => {
    expect(
      resolveControlPanelAppId({
        activeSessionId: null,
        sessionAppId: null,
        appIdBySessionId: {},
      }),
    ).toBeNull()
  })
})
