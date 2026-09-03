import { describe, expect, it } from 'vitest'
import { resolveControlPanelAppId } from '@/lib/apps/app-control-panel'

describe('resolveControlPanelAppId', () => {
  it('prefers selectedAppId over session mapping', () => {
    expect(
      resolveControlPanelAppId({
        selectedAppId: 'app-a',
        activeSessionId: 'sess-1',
        appIdBySessionId: { 'sess-1': 'app-b' },
      }),
    ).toBe('app-a')
  })

  it('falls back to active session appId when nothing selected', () => {
    expect(
      resolveControlPanelAppId({
        selectedAppId: null,
        activeSessionId: 'sess-2',
        appIdBySessionId: { 'sess-2': 'app-c' },
      }),
    ).toBe('app-c')
  })

  it('returns null when neither selected app nor session link exists', () => {
    expect(
      resolveControlPanelAppId({
        selectedAppId: null,
        activeSessionId: 'sess-x',
        appIdBySessionId: {},
      }),
    ).toBeNull()
  })
})
