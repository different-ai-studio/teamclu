/**
 * The dialog must offer exactly the people the server would actually honour.
 *
 * The server denies a path when ANY prefix covering it lacks a grant, so a child
 * folder can never re-open what an ancestor closed. The candidate set is
 * therefore the intersection of the ancestor rules — and since the roster lives
 * behind a search box, that set is observable as the count on "Add person".
 *
 * The other thing pinned here is the shape at rest: an unrestricted folder shows
 * a sentence and a button, never a list. A team can have hundreds of members,
 * and rendering them all was both unusable and — because a rule stores explicit
 * actor ids — a way to write a 299-name list that silently excludes everyone
 * hired afterwards.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
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
      typeof fallback === 'string'
        ? fallback
        : ((fallback as { defaultValue?: string })?.defaultValue ?? _k),
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

/** How many people the picker would offer — i.e. what the parent chain allows. */
function addableCount(): number {
  const button = screen.getByRole('button', { name: /Add person/ })
  return Number(button.textContent?.match(/(\d+)\s*$/)?.[1] ?? NaN)
}

async function enterRestrictMode() {
  fireEvent.click(await screen.findByRole('button', { name: /Restrict to specific people/ }))
}

beforeEach(() => {
  vi.clearAllMocks()
  listTeamMembersForAccess.mockResolvedValue(MEMBERS)
})

describe('KnowledgeAclDialog', () => {
  it('an unrestricted folder shows a sentence and a button, not a roster', async () => {
    listKnowledgeAcl.mockResolvedValue([])
    render(<KnowledgeAclDialog prefix="knowledge/hr/" open onOpenChange={() => {}} />)

    await waitFor(() => expect(screen.getByText(/Everyone on the team can see/)).toBeTruthy())
    // The point of the redesign: nobody is listed until a restriction is chosen.
    expect(screen.queryByText('Alice')).toBeNull()
    expect(screen.queryByRole('button', { name: /Add person/ })).toBeNull()
  })

  it('says new joiners are excluded, because a rule is a list of people', async () => {
    listKnowledgeAcl.mockResolvedValue([])
    render(<KnowledgeAclDialog prefix="knowledge/hr/" open onOpenChange={() => {}} />)
    await enterRestrictMode()

    expect(screen.getByText(/Anyone who joins the team later will not/)).toBeTruthy()
  })

  it('offers the whole team when no ancestor folder is restricted', async () => {
    listKnowledgeAcl.mockResolvedValue([])
    render(<KnowledgeAclDialog prefix="knowledge/hr/" open onOpenChange={() => {}} />)
    await enterRestrictMode()

    expect(addableCount()).toBe(3)
  })

  it('offers only the people the parent allows', async () => {
    listKnowledgeAcl.mockResolvedValue([rule('knowledge/hr/', ['alice'])])
    render(<KnowledgeAclDialog prefix="knowledge/hr/salary/" open onOpenChange={() => {}} />)
    await enterRestrictMode()

    // Bob and Carol would be grants the server ignores, so they are not offered.
    expect(addableCount()).toBe(1)
  })

  it('takes the intersection when several ancestors restrict the path', async () => {
    listKnowledgeAcl.mockResolvedValue([
      rule('knowledge/hr/', ['alice', 'bob']),
      rule('knowledge/hr/pay/', ['bob', 'carol']),
    ])
    render(<KnowledgeAclDialog prefix="knowledge/hr/pay/2026/" open onOpenChange={() => {}} />)
    await enterRestrictMode()

    // Only Bob is in both; the strictest rule wins.
    expect(addableCount()).toBe(1)
  })

  it("lists this folder's own grants, and offers only the rest of the inherited set", async () => {
    listKnowledgeAcl.mockResolvedValue([
      rule('knowledge/hr/', ['alice', 'bob', 'carol']),
      rule('knowledge/hr/salary/', ['alice']),
    ])
    render(<KnowledgeAclDialog prefix="knowledge/hr/salary/" open onOpenChange={() => {}} />)

    await waitFor(() => expect(screen.getByText('Alice')).toBeTruthy())
    expect(screen.queryByText('Bob')).toBeNull()
    // Bob and Carol remain addable; Alice is already on the list.
    expect(addableCount()).toBe(2)
  })

  it('the people picker opens inside the dialog, not portalled to body', async () => {
    // Radix Dialog puts `pointer-events: none` on body and traps focus. A
    // Popover portalled to body therefore lands outside the trap: the trigger
    // looks fine and clicking it does nothing the user can reach. The fix is a
    // portal container, and this is what asserts it stayed.
    listKnowledgeAcl.mockResolvedValue([])
    render(<KnowledgeAclDialog prefix="knowledge/hr/" open onOpenChange={() => {}} />)
    await enterRestrictMode()

    fireEvent.click(screen.getByRole('button', { name: /Add person/ }))

    const input = await screen.findByPlaceholderText(/Search people/)
    const dialog = document.querySelector('[data-slot=dialog-content]')
    expect(dialog, 'dialog content should exist').toBeTruthy()
    expect(
      dialog?.contains(input),
      'the picker must render inside the dialog, or it is unreachable',
    ).toBe(true)
  })

  it('a sibling folder is not treated as an ancestor', async () => {
    // knowledge/hr-public/ only looks like a prefix of knowledge/hr… if the
    // trailing slash is dropped. It must not constrain this folder.
    listKnowledgeAcl.mockResolvedValue([rule('knowledge/hr-public/', ['alice'])])
    render(<KnowledgeAclDialog prefix="knowledge/hr/" open onOpenChange={() => {}} />)
    await enterRestrictMode()

    expect(addableCount()).toBe(3)
  })
})
