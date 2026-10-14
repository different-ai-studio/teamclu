import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { KnowledgeAclSection } from '../KnowledgeAclSection'

const listKnowledgeAcl = vi.fn()
const updateKnowledgeAcl = vi.fn()
const deleteKnowledgeAcl = vi.fn()
const listDocumentLibraries = vi.fn()
const deleteDocumentLibrary = vi.fn()
const listTeamMembersForAccess = vi.fn()

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    knowledgeAcl: {
      listKnowledgeAcl,
      updateKnowledgeAcl,
      deleteKnowledgeAcl,
    },
    documentLibraries: {
      listDocumentLibraries,
      deleteDocumentLibrary,
    },
    actors: {
      listTeamMembersForAccess,
    },
  }),
}))

vi.mock('@/lib/team/team-permissions', () => ({
  useTeamPermissions: () => ({ canManageTeam: true }),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (sel: (s: unknown) => unknown) => sel({ team: { id: 'team-1' } }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => {
      if (typeof fallback === 'string') return fallback
      const opts = (fallback ?? {}) as Record<string, unknown>
      const template = (opts.defaultValue as string | undefined) ?? key
      return template.replace(/\{\{(\w+)\}\}/g, (_m: string, name: string) =>
        name in opts ? String(opts[name]) : `{{${name}}}`,
      )
    },
  }),
}))

const MEMBERS = [
  { id: 'alice', displayName: 'Alice' },
  { id: 'bob', displayName: 'Bob' },
]

const FINANCE_PREFIX = 'documents/财务/'

beforeEach(() => {
  vi.clearAllMocks()
  listTeamMembersForAccess.mockResolvedValue(MEMBERS)
  updateKnowledgeAcl.mockResolvedValue(undefined)
  deleteKnowledgeAcl.mockResolvedValue(undefined)
  deleteDocumentLibrary.mockResolvedValue(undefined)

  listKnowledgeAcl.mockResolvedValue([
    {
      id: 'rule-hr',
      pathPrefix: 'knowledge/hr/',
      actorIds: ['alice'],
    },
    {
      id: 'rule-finance-top',
      pathPrefix: FINANCE_PREFIX,
      actorIds: [],
    },
    {
      id: 'rule-finance-nested',
      pathPrefix: 'documents/财务/工资/',
      actorIds: ['bob'],
    },
  ])

  listDocumentLibraries.mockResolvedValue([
    {
      id: 'lib-finance',
      pathPrefix: FINANCE_PREFIX,
      audience: 'roles',
      roles: [
        { id: 'role-owner', code: 'owner', name: '拥有者', status: 'active' },
        { id: 'role-finance', code: 'finance', name: '财务', status: 'active' },
      ],
      actorIds: [],
    },
  ])
})

async function waitLoaded() {
  await waitFor(() => expect(listKnowledgeAcl).toHaveBeenCalled())
  await waitFor(() => expect(listDocumentLibraries).toHaveBeenCalled())
  await waitFor(() => expect(screen.queryByText(/Loading/)).toBeNull())
}

function cardForPath(path: string) {
  let el: HTMLElement | null = screen.getByText(path)
  while (el && !el.className.includes('rounded-[14px]')) {
    el = el.parentElement
  }
  expect(el).toBeTruthy()
  return el as HTMLElement
}

describe('KnowledgeAclSection document libraries', () => {
  it('lists role-gated folders separately from person rules', async () => {
    render(<KnowledgeAclSection />)
    await waitLoaded()

    expect(screen.getByText('资料库文件夹')).toBeTruthy()

    const financeCard = cardForPath(FINANCE_PREFIX)
    expect(within(financeCard).getByText('拥有者 · 财务')).toBeTruthy()
    expect(within(financeCard).queryByRole('checkbox')).toBeNull()

    const hrCard = cardForPath('knowledge/hr/')
    fireEvent.click(within(hrCard).getByRole('checkbox', { name: 'Bob' }))
    await waitFor(() =>
      expect(updateKnowledgeAcl).toHaveBeenCalledWith('team-1', 'rule-hr', {
        addActorIds: ['bob'],
      }),
    )

    const nestedCard = cardForPath('documents/财务/工资/')
    expect(within(nestedCard).getByRole('checkbox', { name: 'Bob' })).toBeTruthy()
    fireEvent.click(within(nestedCard).getByRole('checkbox', { name: 'Alice' }))
    await waitFor(() =>
      expect(updateKnowledgeAcl).toHaveBeenCalledWith('team-1', 'rule-finance-nested', {
        addActorIds: ['alice'],
      }),
    )

    const financeRemove = within(financeCard).getByRole('button', { name: /Remove restriction/i })
    fireEvent.click(financeRemove)
    await waitFor(() =>
      expect(deleteDocumentLibrary).toHaveBeenCalledWith('team-1', 'lib-finance'),
    )
    expect(deleteKnowledgeAcl).not.toHaveBeenCalled()
  })
})
