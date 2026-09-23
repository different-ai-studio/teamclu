import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { WikiMaintainerCard } from '../WikiMaintainerCard'
import { useCurrentTeamStore } from '@/stores/current-team'

let canManageTeam = false

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : _key),
  }),
}))

vi.mock('@/lib/team/team-permissions', () => ({
  useTeamPermissions: () => ({
    role: canManageTeam ? 'admin' : 'member',
    isOwner: false,
    canManageTeam,
    canEditFiles: canManageTeam,
  }),
}))

vi.mock('../WikiMaintainerRunSheet', () => ({
  WikiMaintainerRunSheet: ({ open }: { open: boolean }) =>
    open ? <div role="dialog">Maintain wiki dialog</div> : null,
}))

vi.mock('@/lib/knowledge/wiki-maintainer-client', () => ({
  discoverWikiSourceDirectories: () =>
    Promise.resolve([{ path: 'documents/handbook/', label: 'handbook' }]),
  loadWikiCompilerModels: () =>
    Promise.resolve([{ id: 'glm-4.6', name: '标准' }]),
  adoptExistingWiki: vi.fn(),
  loadWikiMaintenanceBootstrap: () =>
    Promise.resolve({
      sourceDirectories: [],
      compilerModel: '',
      checkpointModel: '',
      needsAdopt: false,
      recoveredSummary: null,
    }),
  pickSavedCompilerModel: (saved: string, models: { id: string }[]) =>
    (saved && models.some((model) => model.id === saved) ? saved : models[0]?.id) ?? '',
  prepareWikiMaintenance: vi.fn(),
  publishWikiMaintenance: vi.fn(),
  cancelWikiMaintenance: vi.fn(),
}))

describe('WikiMaintainerCard', () => {
  it('shows members a read-only explanation without maintenance controls', () => {
    canManageTeam = false
    useCurrentTeamStore.setState({
      team: { id: '11111111-1111-4111-8111-111111111111', name: 't', slug: 't' },
    } as never)

    render(<WikiMaintainerCard />)
    expect(screen.getByText('LLM Wiki')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Maintain Wiki' })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('lets an owner or admin open the single maintenance flow', async () => {
    canManageTeam = true
    useCurrentTeamStore.setState({
      team: { id: '11111111-1111-4111-8111-111111111111', name: 't', slug: 't' },
    } as never)

    render(<WikiMaintainerCard />)
    fireEvent.click(screen.getByRole('button', { name: 'Maintain Wiki' }))
    expect(await screen.findByRole('dialog')).toHaveTextContent('Maintain wiki dialog')
    expect(screen.queryByTestId('wiki-maintainer-toggle')).toBeNull()
  })
})
