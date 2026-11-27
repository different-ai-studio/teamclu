import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  linkApp: vi.fn(async () => {}),
  getApp: vi.fn(async (id: string) => ({ id, name: 'Fetched' })),
  openAppSession: vi.fn(async () => {}),
  load: vi.fn(async () => {}),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({ sessions: { linkApp: mocks.linkApp }, apps: { getApp: mocks.getApp } }),
}))
vi.mock('@/lib/apps/app-session', () => ({ openAppSession: mocks.openAppSession }))
vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: { getState: () => ({ team: { id: 'team-1' } }) },
}))

import { linkSessionToApp } from '@/lib/apps/link-session-app'
import { useAppsStore } from '@/stores/apps-store'
import { useSessionListStore, type SessionListEntry } from '@/stores/session-list-store'

const row = {
  id: 'sess-1',
  team_id: 'team-1',
  title: 'Chat',
  mode: 'collab',
  app_id: null,
  source: 'user',
  last_message_at: null,
  created_at: '2026-11-27T00:00:00Z',
  updated_at: '2026-11-27T00:00:00Z',
} as SessionListEntry

describe('linkSessionToApp', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSessionListStore.setState({ rows: [row] })
    useAppsStore.setState({ items: [], appIdBySessionId: {}, sessionIdByAppId: {}, load: mocks.load })
  })

  it('links, moves the row under the app and seats the session on its checkout', async () => {
    const known = { id: 'app-1', name: 'Known' }
    useAppsStore.setState({ items: [known as never] })
    const app = await linkSessionToApp('sess-1', 'app-1')

    expect(mocks.linkApp).toHaveBeenCalledWith('sess-1', 'app-1')
    expect(useSessionListStore.getState().rows[0].app_id).toBe('app-1')
    expect(useAppsStore.getState().appIdBySessionId['sess-1']).toBe('app-1')
    expect(mocks.openAppSession).toHaveBeenCalledWith(known, 'sess-1')
    expect(mocks.getApp).not.toHaveBeenCalled()
    expect(app).toBe(known)
  })

  it('fetches an app the list does not have yet and refreshes the list', async () => {
    await linkSessionToApp('sess-1', 'app-new')
    expect(mocks.getApp).toHaveBeenCalledWith('app-new')
    expect(mocks.load).toHaveBeenCalledWith('team-1', { force: true })
    expect(mocks.openAppSession).toHaveBeenCalledWith({ id: 'app-new', name: 'Fetched' }, 'sess-1')
  })

  it('changes nothing locally when the link is refused', async () => {
    mocks.linkApp.mockRejectedValueOnce(new Error('session_already_linked'))
    await expect(linkSessionToApp('sess-1', 'app-1')).rejects.toThrow('session_already_linked')
    expect(useSessionListStore.getState().rows[0].app_id).toBeNull()
    expect(mocks.openAppSession).not.toHaveBeenCalled()
  })
})
