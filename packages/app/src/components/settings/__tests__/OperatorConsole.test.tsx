import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { resetPlatformOperatorCacheForTests } from '@/lib/admin/platform-operator'
import { CREDITS_PER_POINT } from '@/lib/ui/credit-points'
import type { AdminOrg, AdminTeamCredits, AdminTeamRow } from '@/lib/backend/types'

const t = (k: string, d?: string, opts?: Record<string, unknown>) => {
  const base = typeof d === 'string' ? d : k
  return base.replace(/\{\{(\w+)\}\}/g, (_, name) => String(opts?.[name] ?? ''))
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t, i18n: { language: 'zh-CN', changeLanguage: vi.fn() } }),
}))

const api = vi.hoisted(() => ({
  whoami: vi.fn(),
  listOrgs: vi.fn(),
  updateOrg: vi.fn(),
  listTeams: vi.fn(),
  getTeamCredits: vi.fn(),
  setTeamQuotas: vi.fn(),
  topUpCredits: vi.fn(),
}))

vi.mock('@/lib/backend', () => ({
  hasBackendConfig: () => true,
  getBackend: () => ({ admin: api, teams: { topUpCredits: api.topUpCredits } }),
}))

const ui = vi.hoisted(() => ({ orgFilter: null as string | null, openOperatorTeams: vi.fn(), clearOperatorOrgFilter: vi.fn() }))
vi.mock('@/stores/ui', () => ({
  useUIStore: (sel: (s: unknown) => unknown) =>
    sel({
      operatorOrgFilter: ui.orgFilter,
      openOperatorTeams: ui.openOperatorTeams,
      clearOperatorOrgFilter: ui.clearOperatorOrgFilter,
    }),
}))

const { OperatorOrgsSection } = await import('../OperatorOrgsSection')
const { OperatorCreditsSection } = await import('../OperatorCreditsSection')

const ORG: AdminOrg = {
  id: 'org-1',
  name: 'Acme',
  code: 'acme',
  status: 'active',
  createdAt: '2026-09-01T00:00:00Z',
  teamCount: 3,
  memberCount: 7,
}

const TEAM: AdminTeamRow = {
  id: 'team-1',
  slug: 'acme-core',
  name: 'Core',
  orgId: 'org-1',
  orgName: 'Acme',
  createdAt: '2026-09-02T00:00:00Z',
  memberCount: 4,
  // 500 points of balance, 12 points spent this month.
  balanceCredits: 500 * CREDITS_PER_POINT,
  periodCredits: 12 * CREDITS_PER_POINT,
}

const DETAIL: AdminTeamCredits = {
  team: { id: 'team-1', slug: 'acme-core', name: 'Core', orgId: 'org-1', orgName: 'Acme', createdAt: '2026-09-02T00:00:00Z' },
  balanceCredits: 500 * CREDITS_PER_POINT,
  usage: {
    range: 'month',
    startUtc: '2026-08-31T16:00:00Z',
    endUtc: '2026-09-30T16:00:00Z',
    summary: { credits: 12 * CREDITS_PER_POINT },
  },
  ledger: [
    { id: 'l1', kind: 'grant', amountCredits: 100 * CREDITS_PER_POINT, note: 'welcome', createdAt: '2026-09-05T02:00:00Z' },
    { id: 'l2', kind: 'refund', amountCredits: -5 * CREDITS_PER_POINT, note: null, createdAt: '2026-09-06T02:00:00Z' },
  ],
  quotas: {
    period: 'month',
    defaultLimitCredits: 50 * CREDITS_PER_POINT,
    lowBalanceCredits: null,
    members: [{ actorId: 'actor-1', displayName: 'Ada', actorType: 'member', limitCredits: 20 * CREDITS_PER_POINT }],
  },
  actors: [
    { id: 'actor-1', displayName: 'Ada', actorType: 'member' },
    { id: 'actor-2', displayName: 'Helper', actorType: 'agent' },
  ],
}

beforeEach(() => {
  resetPlatformOperatorCacheForTests()
  for (const fn of Object.values(api)) fn.mockReset()
  ui.orgFilter = null
  ui.openOperatorTeams.mockReset()
  ui.clearOperatorOrgFilter.mockReset()
  api.whoami.mockResolvedValue({ userId: 'op-1', operator: true })
  api.listOrgs.mockResolvedValue({ items: [ORG], total: 1 })
  api.updateOrg.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...ORG, ...patch }))
  api.listTeams.mockResolvedValue({ items: [TEAM], total: 1, truncated: false })
  api.getTeamCredits.mockResolvedValue(DETAIL)
  api.setTeamQuotas.mockResolvedValue({ ok: true })
  api.topUpCredits.mockResolvedValue({ applied: true, balanceCredits: 600 * CREDITS_PER_POINT })
})

describe('OperatorOrgsSection', () => {
  it('lists orgs with their counts', async () => {
    render(<OperatorOrgsSection />)
    await screen.findByTestId('operator-org-org-1')
    expect(screen.getByText('Acme')).toBeTruthy()
    expect(screen.getByText('3 teams')).toBeTruthy()
    expect(screen.getByText('7 people')).toBeTruthy()
  })

  it('renames an org in place', async () => {
    render(<OperatorOrgsSection />)
    await screen.findByTestId('operator-org-org-1')

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    const input = screen.getByLabelText('Org name') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Acme Inc' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.updateOrg).toHaveBeenCalledWith('org-1', { name: 'Acme Inc' }))
    await screen.findByText('Acme Inc')
  })

  it('toggles an org in and out of service', async () => {
    render(<OperatorOrgsSection />)
    await screen.findByTestId('operator-org-org-1')

    fireEvent.click(screen.getByRole('button', { name: 'Take out of service' }))
    await waitFor(() => expect(api.updateOrg).toHaveBeenCalledWith('org-1', { status: 'inactive' }))
    // The row now offers the opposite action, from the server's own answer.
    await screen.findByRole('button', { name: 'Put back in service' })
  })

  it('searches by name, and only when asked', async () => {
    render(<OperatorOrgsSection />)
    await screen.findByTestId('operator-org-org-1')
    api.listOrgs.mockClear()

    fireEvent.change(screen.getByLabelText('Search orgs'), { target: { value: 'acme' } })
    expect(api.listOrgs).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Search orgs' }))
    await waitFor(() =>
      expect(api.listOrgs).toHaveBeenCalledWith(expect.objectContaining({ query: 'acme', offset: 0 })),
    )
  })

  it('jumps to that org’s teams', async () => {
    render(<OperatorOrgsSection />)
    await screen.findByTestId('operator-org-org-1')
    fireEvent.click(screen.getByRole('button', { name: 'Teams and credits' }))
    expect(ui.openOperatorTeams).toHaveBeenCalledWith('org-1')
  })

  it('shows a non-operator their own user id', async () => {
    api.whoami.mockResolvedValue({ userId: 'user-9', operator: false })
    render(<OperatorOrgsSection />)
    await screen.findByTestId('operator-only')
    expect(screen.getByText('user-9')).toBeTruthy()
    expect(api.listOrgs).not.toHaveBeenCalled()
  })
})

describe('OperatorCreditsSection', () => {
  it('ranks teams by balance by default, in points', async () => {
    render(<OperatorCreditsSection />)
    await screen.findByTestId('operator-team-team-1')
    expect(api.listTeams).toHaveBeenCalledWith(expect.objectContaining({ sort: 'balance', offset: 0 }))
    expect(screen.getByText('500')).toBeTruthy()
    expect(screen.getByText('−12')).toBeTruthy()
  })

  it('drops the sort when the newest-first view is picked', async () => {
    render(<OperatorCreditsSection />)
    await screen.findByTestId('operator-team-team-1')

    fireEvent.click(screen.getByRole('button', { name: 'Newest' }))
    await waitFor(() => expect(api.listTeams).toHaveBeenLastCalledWith(expect.objectContaining({ sort: undefined })))
  })

  it('applies an org filter it was sent with, then forgets it', async () => {
    ui.orgFilter = 'org-1'
    render(<OperatorCreditsSection />)

    await waitFor(() => expect(api.listTeams).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-1' })))
    // Cleared, so coming back here later is not stuck on last week's org.
    expect(ui.clearOperatorOrgFilter).toHaveBeenCalled()
  })

  it('opens a team and shows its balance, limits and history', async () => {
    render(<OperatorCreditsSection />)
    fireEvent.click(await screen.findByTestId('operator-team-team-1'))

    await screen.findByTestId('operator-team-detail')
    expect(api.getTeamCredits).toHaveBeenCalledWith('team-1')
    expect(screen.getByText('+100')).toBeTruthy()
    expect(screen.getByText('−5')).toBeTruthy()
    // Limits arrive in credits and are edited in points.
    expect((screen.getByLabelText('Default per member') as HTMLInputElement).value).toBe('50')
    expect((screen.getByLabelText('Ada limit') as HTMLInputElement).value).toBe('20')
    expect((screen.getByLabelText('Helper limit') as HTMLInputElement).value).toBe('')
  })

  it('grants points as credits, with a key a retry can reuse', async () => {
    render(<OperatorCreditsSection />)
    fireEvent.click(await screen.findByTestId('operator-team-team-1'))
    await screen.findByTestId('operator-team-detail')

    fireEvent.change(screen.getByLabelText('Points'), { target: { value: '250' } })
    fireEvent.change(screen.getByLabelText('Note (the team owner sees this)'), { target: { value: 'onboarding' } })
    fireEvent.click(screen.getByRole('button', { name: 'Grant' }))

    await waitFor(() => expect(api.topUpCredits).toHaveBeenCalled())
    const [teamId, input] = api.topUpCredits.mock.calls[0]
    expect(teamId).toBe('team-1')
    expect(input.amountCredits).toBe(250 * CREDITS_PER_POINT)
    // A grant, not a payment: `top_up` is what revenue is counted from.
    expect(input.kind).toBe('grant')
    expect(input.note).toBe('onboarding')
    expect(input.idempotencyKey).toMatch(/^operator-grant:/)
    await screen.findByText(/Granted/)
  })

  it('says so when the same grant was already applied', async () => {
    api.topUpCredits.mockResolvedValue({ applied: false, balanceCredits: 500 * CREDITS_PER_POINT })
    render(<OperatorCreditsSection />)
    fireEvent.click(await screen.findByTestId('operator-team-team-1'))
    await screen.findByTestId('operator-team-detail')

    fireEvent.change(screen.getByLabelText('Points'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Grant' }))
    await screen.findByText(/Already applied/)
  })

  it('saves limits in credits, and a blank field means no limit', async () => {
    render(<OperatorCreditsSection />)
    fireEvent.click(await screen.findByTestId('operator-team-team-1'))
    await screen.findByTestId('operator-team-detail')

    fireEvent.change(screen.getByLabelText('Default per member'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Ada limit'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Weekly' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save limits' }))

    await waitFor(() => expect(api.setTeamQuotas).toHaveBeenCalled())
    const [, input] = api.setTeamQuotas.mock.calls[0]
    expect(input.period).toBe('week')
    expect(input.defaultLimitCredits).toBeNull()
    expect(input.members).toEqual(
      expect.arrayContaining([{ actorId: 'actor-1', limitCredits: 30 * CREDITS_PER_POINT }]),
    )
  })

  it('warns when the deployment has more teams than one read covers', async () => {
    api.listTeams.mockResolvedValue({ items: [TEAM], total: 1, truncated: true })
    render(<OperatorCreditsSection />)
    await screen.findByTestId('operator-credits-truncated')
  })
})
