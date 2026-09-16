import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CloudApiError } from '@/lib/backend/cloud-api/http'
import type { OrgRole } from '@/lib/backend/cloud-api/org-roles'

const t = (k: string, d?: string, opts?: Record<string, unknown>) => {
  const base = typeof d === 'string' ? d : k
  return base.replace(/\{\{(\w+)\}\}/g, (_, name) => String(opts?.[name] ?? ''))
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t, i18n: { language: 'zh-CN', changeLanguage: vi.fn() } }),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (sel: (s: unknown) => unknown) => sel({ team: { id: 'team-1' } }),
}))

const perms = vi.hoisted(() => ({ canManageTeam: true }))
vi.mock('@/lib/team/team-permissions', () => ({
  useTeamPermissions: () => ({
    role: 'admin',
    isOwner: false,
    canManageTeam: perms.canManageTeam,
    canEditFiles: true,
  }),
}))

const SYSTEM: OrgRole = {
  id: 'role-owner',
  orgId: 'org-1',
  name: 'Owner',
  code: 'owner',
  description: 'Team owner',
  isSystem: true,
  status: 'active',
  sort: 1,
  parentRoleId: null,
}

const CUSTOM: OrgRole = {
  id: 'role-custom',
  orgId: 'org-1',
  name: 'Reviewer',
  code: 'reviewer',
  description: 'Custom reviewer',
  isSystem: false,
  status: 'active',
  sort: 50,
  parentRoleId: null,
}

const list = vi.fn(async () => [SYSTEM, CUSTOM] as OrgRole[])
const create = vi.fn(async (_teamId: string, input: { name: string; code: string }) => ({
  ...CUSTOM,
  id: 'role-new',
  name: input.name,
  code: input.code,
}))
const patch = vi.fn(async () => CUSTOM)
const remove = vi.fn(async () => undefined)

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    orgRoles: { list, create, patch, remove },
  }),
}))

const { TeamRolesSection } = await import('../TeamRolesSection')

beforeEach(() => {
  perms.canManageTeam = true
  list.mockClear()
  list.mockResolvedValue([SYSTEM, CUSTOM])
  create.mockClear()
  patch.mockClear()
  remove.mockClear()
  remove.mockResolvedValue(undefined)
})

describe('TeamRolesSection', () => {
  it('lists system and custom roles', async () => {
    render(<TeamRolesSection />)
    await screen.findByText('Owner')
    expect(screen.getByText('owner')).toBeInTheDocument()
    expect(screen.getByText('Reviewer')).toBeInTheDocument()
    expect(screen.getByText('reviewer')).toBeInTheDocument()
    expect(list).toHaveBeenCalledWith('team-1')
  })

  it('system rows have no edit or delete actions', async () => {
    render(<TeamRolesSection />)
    await screen.findByText('Owner')

    const ownerRow = screen.getByTestId('org-role-row-role-owner')
    expect(within(ownerRow).queryByRole('button', { name: /edit|编辑/i })).toBeNull()
    expect(within(ownerRow).queryByRole('button', { name: /delete|删除/i })).toBeNull()

    const customRow = screen.getByTestId('org-role-row-role-custom')
    expect(within(customRow).getByRole('button', { name: /edit|编辑/i })).toBeInTheDocument()
    expect(within(customRow).getByRole('button', { name: /delete|删除/i })).toBeInTheDocument()
  })

  it('create calls orgRoles.create', async () => {
    render(<TeamRolesSection />)
    await screen.findByText('Owner')

    fireEvent.click(screen.getByRole('button', { name: /新建角色|New role/i }))
    fireEvent.change(screen.getByLabelText(/名称|Name/i), { target: { value: 'Auditor' } })
    fireEvent.change(screen.getByLabelText(/代码|Code/i), { target: { value: 'auditor' } })
    fireEvent.click(screen.getByRole('button', { name: /创建|Create/i }))

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith('team-1', {
        name: 'Auditor',
        code: 'auditor',
      }),
    )
  })

  it('delete 409 shows binding count', async () => {
    remove.mockRejectedValueOnce(
      new CloudApiError(409, 'conflict', 'role still has member bindings', null, {
        bindingCount: 3,
      }),
    )
    render(<TeamRolesSection />)
    await screen.findByText('Reviewer')

    fireEvent.click(
      within(screen.getByTestId('org-role-row-role-custom')).getByRole('button', {
        name: /delete|删除/i,
      }),
    )

    await screen.findByText(/3/)
    expect(screen.getByText(/binding|绑定|成员/i)).toBeInTheDocument()
  })
})
