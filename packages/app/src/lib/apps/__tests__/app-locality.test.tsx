/**
 * An app row follows the account onto every machine it signs in on; the
 * checkout does not. Everything that offers to open an app has to tell the two
 * apart, and has to keep "the daemon has not said yet" distinct from "no".
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { resolveAppLocality, useSessionApp } from '@/lib/apps/app-locality'
import { useAppsStore } from '@/stores/apps-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useSessionListStore } from '@/stores/session-list-store'
import type { AppRow } from '@/lib/backend/types'

const mkApp = (id: string, name: string): AppRow =>
  ({
    id,
    teamId: 'team-1',
    name,
    slug: id,
    type: 'static_web',
    visibility: 'personal',
    workspaceId: null,
    gitRemoteUrl: null,
    gitAuthKind: null,
    provisionStatus: 'ready',
    fcStatus: null,
    fcEndpoint: null,
    publicUrl: null,
    authMode: 'none',
    runtime: 'node',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }) as AppRow

describe('resolveAppLocality', () => {
  it('answers unknown until the daemon has listed the local apps', () => {
    expect(resolveAppLocality(null, 'app-1')).toBeNull()
  })

  it('answers no for an app the daemon did not list', () => {
    expect(resolveAppLocality(['app-2'], 'app-1')).toBe(false)
  })

  it('answers yes for one it did', () => {
    expect(resolveAppLocality(['app-1', 'app-2'], 'app-1')).toBe(true)
  })

  it('answers unknown for a session with no app at all', () => {
    // A plain session is not "an app that is missing" — it has no app, and the
    // callers must not treat it as one.
    expect(resolveAppLocality([], null)).toBeNull()
  })
})

describe('useSessionApp', () => {
  beforeEach(() => {
    useCurrentTeamStore.setState({ team: { id: 'team-1' } as never })
    useAppsStore.setState({
      items: [mkApp('app-1', 'Alpha')],
      localAppIds: [],
      load: vi.fn().mockResolvedValue(undefined),
      refreshLocalApps: vi.fn().mockResolvedValue(undefined),
    })
    useSessionListStore.setState({
      rows: [
        { id: 's-app', title: 'A', team_id: 'team-1', app_id: 'app-1' },
        { id: 's-plain', title: 'B', team_id: 'team-1', app_id: null },
      ] as never,
    })
  })

  it('resolves the session app and says it is not here', () => {
    const { result } = renderHook(() => useSessionApp('s-app'))
    expect(result.current.app?.name).toBe('Alpha')
    expect(result.current.local).toBe(false)
  })

  it('says nothing about a session that has no app', () => {
    const { result } = renderHook(() => useSessionApp('s-plain'))
    expect(result.current.app).toBeNull()
    expect(result.current.local).toBeNull()
  })

  it('stays unknown while the app list has not arrived', () => {
    // The libsql cache does not mirror `app_id`, so a row painted from cache on
    // a cold start carries null. A chat must not be shut down by a column that
    // has merely not landed yet.
    useAppsStore.setState({ items: [] })
    const { result } = renderHook(() => useSessionApp('s-app'))
    expect(result.current.app).toBeNull()
    expect(result.current.local).toBeNull()
  })

  it('stays unknown while the daemon has not answered', () => {
    useAppsStore.setState({ localAppIds: null })
    const { result } = renderHook(() => useSessionApp('s-app'))
    expect(result.current.app?.id).toBe('app-1')
    expect(result.current.local).toBeNull()
  })

  it('asks for both halves only once a session claims an app', () => {
    renderHook(() => useSessionApp('s-plain'))
    expect(useAppsStore.getState().load).not.toHaveBeenCalled()
    expect(useAppsStore.getState().refreshLocalApps).not.toHaveBeenCalled()

    renderHook(() => useSessionApp('s-app'))
    expect(useAppsStore.getState().load).toHaveBeenCalledWith('team-1')
    expect(useAppsStore.getState().refreshLocalApps).toHaveBeenCalledWith('team-1')
  })
})
