/**
 * The dialog's whole job is to show a set of people that matches what the
 * server will actually enforce. The server denies a path when ANY prefix
 * covering it lacks a grant, so a child directory can never re-open what a
 * parent closed.
 *
 * These tests pin that: the candidate list is the intersection of the ancestor
 * rules, and someone the parent does not allow is offered as disabled rather
 * than as a checkbox that would store a grant with no effect.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { KnowledgeAclDialog } from '../KnowledgeAclDialog'

const listKnowledgeAcl = vi.fn()
const listTeamMembersForAccess = vi.fn()

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    knowledgeAcl: {
      listKnowledgeAcl,
      previewKnowledgeAcl: vi.fn(),
      createKnowledgeAcl: vi.fn(),
      updateKnowledgeAcl: vi.fn(),
      deleteKnowledgeAcl: vi.fn(),
    },
    actors: { listTeamMembersForAccess },
  }),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (sel: (s: unknown) => unknown) => sel({ team: { id: 'team-1' } }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, fallback?: unknown) =>
      typeof fallback === 'string' ? fallback : (fallback as { defaultValue?: string })?.defaultValue ?? _k,
  }),
}))

const MEMBERS = [
  { id: 'alice', displayName: 'Alice' },
  { id: 'bob', displayName: 'Bob' },
  { id: 'carol', displayName: 'Carol' },
]

const rule = (pathPrefix: string, actorIds: string[]) => ({
  id: `rule-${pathPrefix}`,
  pathPrefix,
  actorIds,
  createdBy: 'alice',
  createdAt: null,
  updatedAt: null,
})

/** The checkbox for a person, and whether the UI offers it at all. */
function personRow(name: string) {
  const label = screen.getByText(name).closest('label')
  if (!label) throw new Error(`no row for ${name}`)
  const box = label.querySelector('button[role="checkbox"]')
  if (!box) throw new Error(`no checkbox for ${name}`)
  return { label, box, disabled: box.hasAttribute('disabled') }
}

beforeEach(() => {
  vi.clearAllMocks()
  listTeamMembersForAccess.mockResolvedValue(MEMBERS)
})

describe('KnowledgeAclDialog inheritance', () => {
  it('offers everyone when no ancestor directory is restricted', async () => {
    listKnowledgeAcl.mockResolvedValue([])
    render(<KnowledgeAclDialog prefix="knowledge/hr/" open onOpenChange={() => {}} />)

    await waitFor(() => expect(screen.getByText('Alice')).toBeTruthy())
    for (const name of ['Alice', 'Bob', 'Carol']) {
      const { disabled, box } = personRow(name)
      expect(disabled, `${name} should be selectable`).toBe(false)
      expect(box.getAttribute('data-state'), `${name} should start checked`).toBe('checked')
    }
  })

  it('a person the parent does not allow cannot be added here', async () => {
    // knowledge/hr/ is limited to Alice; this dialog is for a folder beneath it.
    listKnowledgeAcl.mockResolvedValue([rule('knowledge/hr/', ['alice'])])
    render(<KnowledgeAclDialog prefix="knowledge/hr/salary/" open onOpenChange={() => {}} />)

    await waitFor(() => expect(screen.getByText('Alice')).toBeTruthy())
    expect(personRow('Alice').disabled).toBe(false)
    // Checking these would store a grant the server ignores, so they are not
    // offered — the dialog says why instead.
    expect(personRow('Bob').disabled, 'Bob is not allowed by the parent').toBe(true)
    expect(personRow('Carol').disabled, 'Carol is not allowed by the parent').toBe(true)
  })

  it('takes the intersection when several ancestors restrict the path', async () => {
    listKnowledgeAcl.mockResolvedValue([
      rule('knowledge/hr/', ['alice', 'bob']),
      rule('knowledge/hr/pay/', ['bob', 'carol']),
    ])
    render(<KnowledgeAclDialog prefix="knowledge/hr/pay/2026/" open onOpenChange={() => {}} />)

    await waitFor(() => expect(screen.getByText('Bob')).toBeTruthy())
    // Only Bob is in both ancestor grants; the strictest rule wins.
    expect(personRow('Bob').disabled).toBe(false)
    expect(personRow('Alice').disabled, 'Alice is excluded by knowledge/hr/pay/').toBe(true)
    expect(personRow('Carol').disabled, 'Carol is excluded by knowledge/hr/').toBe(true)
  })

  it("starts from this folder's own grants when it already has a rule", async () => {
    listKnowledgeAcl.mockResolvedValue([
      rule('knowledge/hr/', ['alice', 'bob', 'carol']),
      rule('knowledge/hr/salary/', ['alice']),
    ])
    render(<KnowledgeAclDialog prefix="knowledge/hr/salary/" open onOpenChange={() => {}} />)

    await waitFor(() => expect(screen.getByText('Alice')).toBeTruthy())
    // All three are selectable — the parent allows them — but only Alice is
    // currently granted here.
    expect(personRow('Alice').box.getAttribute('data-state')).toBe('checked')
    expect(personRow('Bob').box.getAttribute('data-state')).toBe('unchecked')
    expect(personRow('Bob').disabled).toBe(false)
  })

  it('a sibling folder is not treated as an ancestor', async () => {
    // knowledge/hr-public/ shares a textual prefix with knowledge/hr… only if
    // the trailing slash is dropped. It must not constrain this folder.
    listKnowledgeAcl.mockResolvedValue([rule('knowledge/hr-public/', ['alice'])])
    render(<KnowledgeAclDialog prefix="knowledge/hr/" open onOpenChange={() => {}} />)

    await waitFor(() => expect(screen.getByText('Bob')).toBeTruthy())
    expect(personRow('Bob').disabled, 'a sibling rule must not restrict this folder').toBe(false)
  })
})
