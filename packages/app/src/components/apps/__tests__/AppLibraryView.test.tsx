import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { AppLibraryView } from '../AppLibraryView'
import { useAppsStore } from '@/stores/apps-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import type { AppRow } from '@/lib/backend/types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

// A probe rather than `() => null`: one test needs to see that 新建 opened it.
vi.mock('@/components/apps/CreateAppDialog', () => ({
  CreateAppDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="create-app-dialog" /> : null,
}))

// Real one would reach the cache and the network on mount.
vi.mock('@/stores/actor-directory-store', () => ({
  useActorDirectory: () => ({
    actors: [
      { id: 'actor-1', display_name: '海港' },
      { id: 'actor-2', display_name: 'Weigan' },
    ],
  }),
}))

const mkApp = (id: string, name: string, over: Partial<AppRow> = {}): AppRow => ({
  id,
  teamId: 'team-1',
  name,
  slug: id,
  type: 'static_web',
  visibility: 'personal',
  workspaceId: null,
  createdByActorId: 'actor-1',
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
  ...over,
})

const load = vi.fn()
const refreshLocalApps = vi.fn()
const download = vi.fn()

describe('AppLibraryView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    load.mockResolvedValue(undefined)
    refreshLocalApps.mockResolvedValue(undefined)
    download.mockResolvedValue(undefined)
    useCurrentTeamStore.setState({ team: { id: 'team-1' } as never })
    useAppsStore.setState({
      items: [
        mkApp('app-1', 'Mine'),
        mkApp('app-2', 'Teamed', { visibility: 'team' }),
      ],
      loading: false,
      localAppIds: ['app-1'],
      load,
      refreshLocalApps,
      download,
    })
  })

  it('lists every app the caller can see, downloaded or not', () => {
    // The whole point of this view: column two shows only what is here, so a
    // team app nobody downloaded would otherwise be invisible.
    render(<AppLibraryView />)
    expect(screen.getByText('Mine')).toBeInTheDocument()
    expect(screen.getByText('Teamed')).toBeInTheDocument()
  })

  it('an app already on this machine offers no download', () => {
    render(<AppLibraryView />)
    // Counted rather than probed through the DOM around a row: with app-1
    // local and app-2 not, exactly one download control may exist. A structural
    // lookup would just as happily find nothing for the wrong reason.
    expect(screen.getByText('已在本机')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /下载/ })).toHaveLength(1)
  })

  it('downloading an app that is not here calls through with that app', async () => {
    render(<AppLibraryView />)
    fireEvent.click(screen.getByRole('button', { name: /下载/ }))
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ id: 'app-2' }))
  })

  it('refreshes both the cloud list and the local set when opened', async () => {
    render(<AppLibraryView />)
    // `force`: the cloud list can have gained a teammate's app since it was
    // last fetched, and a cached answer is exactly what this view exists to
    // look past.
    await waitFor(() => expect(load).toHaveBeenCalledWith('team-1', { force: true }))
    expect(refreshLocalApps).toHaveBeenCalledWith('team-1')
  })

  it('fetches nothing without a team', () => {
    useCurrentTeamStore.setState({ team: null as never })
    render(<AppLibraryView />)
    expect(load).not.toHaveBeenCalled()
    expect(refreshLocalApps).not.toHaveBeenCalled()
  })

  it('新建 opens the create dialog from here, not from column two', () => {
    render(<AppLibraryView />)
    expect(screen.queryByTestId('create-app-dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /新建/ }))
    expect(screen.getByTestId('create-app-dialog')).toBeInTheDocument()
  })

  it('only the row being downloaded goes busy', async () => {
    let release!: () => void
    download.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    useAppsStore.setState({
      items: [mkApp('app-2', 'Teamed'), mkApp('app-3', 'Other')],
      localAppIds: [],
    })
    render(<AppLibraryView />)

    const buttons = screen.getAllByRole('button', { name: /下载/ })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[0])

    await waitFor(() => expect(buttons[0]).toBeDisabled())
    expect(buttons[1]).toBeEnabled()

    await act(async () => {
      release()
    })
    await waitFor(() => expect(buttons[0]).toBeEnabled())
  })

  it('names the creator, the type and where the code lives', () => {
    // Where the code lives is the load-bearing one: it says whether the row can
    // be downloaded at all.
    useAppsStore.setState({
      items: [
        mkApp('app-1', 'Hosted', { gitAuthKind: 'gitea_deploy_key', gitRemoteUrl: 'ssh://git@g/x.git' }),
        mkApp('app-2', 'External', { gitRemoteUrl: 'https://github.com/o/r.git', createdByActorId: 'actor-2' }),
        mkApp('app-3', 'Only here'),
      ],
      localAppIds: [],
    })
    render(<AppLibraryView />)

    expect(screen.getByText(/海港 · 静态网页 · 托管仓库/)).toBeInTheDocument()
    expect(screen.getByText(/Weigan · 静态网页 · 外部仓库/)).toBeInTheDocument()
    expect(screen.getByText(/海港 · 静态网页 · 仅本机/)).toBeInTheDocument()
  })

  it('falls back when the creator is not in the directory', () => {
    useAppsStore.setState({ items: [mkApp('app-9', 'Orphan', { createdByActorId: 'gone' })] })
    render(<AppLibraryView />)
    expect(screen.getByText(/未知创建人/)).toBeInTheDocument()
  })

  it('search narrows by name', () => {
    render(<AppLibraryView />)
    fireEvent.change(screen.getByLabelText('搜索应用'), { target: { value: 'team' } })
    expect(screen.getByText('Teamed')).toBeInTheDocument()
    expect(screen.queryByText('Mine')).not.toBeInTheDocument()
  })

  it('search also matches the creator, not just the name', () => {
    // In a team list the thing you remember is as often who made it.
    useAppsStore.setState({
      items: [mkApp('app-1', 'Alpha'), mkApp('app-2', 'Beta', { createdByActorId: 'actor-2' })],
    })
    render(<AppLibraryView />)
    fireEvent.change(screen.getByLabelText('搜索应用'), { target: { value: 'weigan' } })
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
  })

  it('a search that matches nothing is not the same as having no apps', () => {
    render(<AppLibraryView />)
    fireEvent.change(screen.getByLabelText('搜索应用'), { target: { value: 'zzzz' } })
    expect(screen.getByText('没有匹配的应用')).toBeInTheDocument()
    expect(screen.queryByText('还没有内容')).not.toBeInTheDocument()
  })

  it('says so when there is nothing to show', () => {
    useAppsStore.setState({ items: [], loading: false })
    render(<AppLibraryView />)
    expect(screen.getByText('还没有内容')).toBeInTheDocument()
  })

  it('shows the loader only before the first list arrives', () => {
    useAppsStore.setState({ items: [], loading: true })
    render(<AppLibraryView />)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })
})
