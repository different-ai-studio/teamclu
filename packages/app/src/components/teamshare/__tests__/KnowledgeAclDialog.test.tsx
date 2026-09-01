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

const previewKnowledgeAcl = vi.fn()
const createKnowledgeAcl = vi.fn()

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    knowledgeAcl: {
      listKnowledgeAcl,
      previewKnowledgeAcl,
      createKnowledgeAcl,
      updateKnowledgeAcl: vi.fn(),
      deleteKnowledgeAcl: vi.fn(),
    },
    actors: { listTeamMembersForAccess },
  }),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (sel: (s: unknown) => unknown) => sel({ team: { id: 'team-1' } }),
}))

// Interpolates {{placeholders}} the way i18next does. Without it the component
// renders raw templates, and an assertion on user-visible text passes or fails
// for the wrong reason.
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
  previewKnowledgeAcl.mockResolvedValue({
    pathPrefix: 'knowledge/hr/',
    affectedFiles: 1,
    affectedMembers: 1,
  })
  createKnowledgeAcl.mockResolvedValue({})
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

  it('the impact panel survives, so save is actually reachable', async () => {
    // The preview used to run through the same helper as a write, which
    // reloaded the rules afterwards — and the reload reset `impact` in the same
    // tick. The panel appeared and vanished, the button flipped back to "check
    // impact", and there was no way to ever reach save.
    listKnowledgeAcl.mockResolvedValue([])
    render(<KnowledgeAclDialog prefix="knowledge/hr/" open onOpenChange={() => {}} />)
    await enterRestrictMode()
    fireEvent.click(screen.getByRole('button', { name: /Add person/ }))
    fireEvent.click(await screen.findByText('Alice'))

    fireEvent.click(screen.getByRole('button', { name: /Check impact/ }))

    // Still there a tick later, and the button is now Save.
    expect(await screen.findByText(/1 member\(s\) will lose access/)).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('button', { name: /Save/ })).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Check impact/ })).toBeNull()
  })

  it('save sends the confirmation the server requires', async () => {
    listKnowledgeAcl.mockResolvedValue([])
    render(<KnowledgeAclDialog prefix="knowledge/hr/" open onOpenChange={() => {}} />)
    await enterRestrictMode()
    fireEvent.click(screen.getByRole('button', { name: /Add person/ }))
    fireEvent.click(await screen.findByText('Alice'))
    fireEvent.click(screen.getByRole('button', { name: /Check impact/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Save/ }))

    await waitFor(() => expect(createKnowledgeAcl).toHaveBeenCalledTimes(1))
    expect(createKnowledgeAcl.mock.calls[0][1]).toMatchObject({
      pathPrefix: 'knowledge/hr/',
      actorIds: ['alice'],
      // Without this the server answers 409 and nothing is written.
      confirmRevokeExisting: true,
    })
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
