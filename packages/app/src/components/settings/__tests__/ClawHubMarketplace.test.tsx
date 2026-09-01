import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type ExploreItem = { slug: string; displayName: string; summary?: string | null }
type ExploreResult = { items: ExploreItem[]; nextCursor: null }

let exploreResponses: Array<ReturnType<typeof deferred<ExploreResult>>> = []
let installedLock: { skills: Record<string, { version: string | null; installedAt: number; source?: string }> } = { skills: {} }

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => d ?? k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn((sel: (s: any) => any) => {
    const state = { workspacePath: '/test' }
    return sel(state)
  }),
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === 'clawhub_list_installed') return installedLock
    if (cmd === 'clawhub_explore') {
      const next = exploreResponses.shift()
      return next?.promise ?? { items: [], nextCursor: null }
    }
    return null
  }),
}))
vi.mock('@/lib/utils', () => ({ cn: (...a: string[]) => a.join(' ') }))
vi.mock('@/lib/clawhub/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/clawhub/types')>()
  return { ...actual, parseStats: () => ({}) }
})
vi.mock('../shared', () => ({
  SettingCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

import { ClawHubMarketplace } from '../ClawHubMarketplace'

describe('ClawHubMarketplace', () => {
  beforeEach(() => {
    exploreResponses = []
    installedLock = { skills: {} }
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders the search input', () => {
    render(<ClawHubMarketplace />)
    expect(screen.getByPlaceholderText('Search ClawHub skills...')).toBeTruthy()
  })

  it('shows skeleton placeholders before the first explore response resolves', async () => {
    const pending = deferred<ExploreResult>()
    exploreResponses.push(pending)

    const { container } = render(<ClawHubMarketplace />)

    await screen.findByPlaceholderText('Search ClawHub skills...')
    await waitFor(() => {
      expect(container.querySelector('[data-slot="skeleton"]')).toBeTruthy()
      expect(screen.queryByText('No skills available')).toBeNull()
    })

    await act(async () => {
      pending.resolve({ items: [], nextCursor: null })
    })
  })

  it('keeps existing results visible while refreshing', async () => {
    const first = deferred<ExploreResult>()
    const second = deferred<ExploreResult>()
    exploreResponses.push(first, second)

    render(<ClawHubMarketplace />)

    await act(async () => {
      first.resolve({ items: [{ slug: 'alpha', displayName: 'Alpha', summary: 'Alpha skill' }], nextCursor: null })
    })

    expect(await screen.findByText('Alpha')).toBeTruthy()

    const refreshButton = screen.getByRole('button', { name: 'Refresh' })
    await act(async () => {
      refreshButton.click()
    })

    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.getByText('Loading...')).toBeTruthy()

    await act(async () => {
      second.resolve({ items: [{ slug: 'alpha', displayName: 'Alpha', summary: 'Alpha skill' }], nextCursor: null })
    })

    expect(screen.getByText('Alpha')).toBeTruthy()
  })

  it('does not treat team lockfile rows as ClawHub-installed', async () => {
    installedLock = {
      skills: {
        alpha: { version: '3', installedAt: 1, source: 'team' },
        beta: { version: '1', installedAt: 1, source: 'clawhub' },
      },
    }
    const first = deferred<ExploreResult>()
    exploreResponses.push(first)

    render(<ClawHubMarketplace />)

    await act(async () => {
      first.resolve({
        items: [
          { slug: 'alpha', displayName: 'Alpha', summary: 'Team pack colliding' },
          { slug: 'beta', displayName: 'Beta', summary: 'ClawHub pack' },
        ],
        nextCursor: null,
      })
    })

    expect(await screen.findByText('Alpha')).toBeTruthy()
    expect(screen.getByText('Beta')).toBeTruthy()
    // Team slug still offers Install; ClawHub slug shows Installed.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Installed/ })).toBeTruthy()
    })
    expect(screen.getAllByRole('button', { name: 'Install' })).toHaveLength(1)
  })
})
