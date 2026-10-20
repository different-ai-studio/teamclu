import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { DocumentLibraryDialog } from '../DocumentLibraryDialog'

const listDocumentLibraries = vi.fn()
const listOrgRoles = vi.fn()
const previewDocumentLibrary = vi.fn()
const createDocumentLibrary = vi.fn()
const putDocumentLibrary = vi.fn()
const deleteDocumentLibrary = vi.fn()

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    documentLibraries: {
      listDocumentLibraries,
      previewDocumentLibrary,
      createDocumentLibrary,
      putDocumentLibrary,
      deleteDocumentLibrary,
    },
    orgRoles: { list: listOrgRoles },
  }),
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

const ROLES = [
  { id: 'role-owner', orgId: 'org-1', name: '拥有者', code: 'owner', description: null, isSystem: true, status: 'active', sort: 1, parentRoleId: null },
  { id: 'role-admin', orgId: 'org-1', name: '管理员', code: 'admin', description: null, isSystem: true, status: 'active', sort: 2, parentRoleId: null },
  { id: 'role-member', orgId: 'org-1', name: '成员', code: 'member', description: null, isSystem: true, status: 'active', sort: 3, parentRoleId: null },
  { id: 'role-finance', orgId: 'org-1', name: '财务', code: 'finance', description: null, isSystem: true, status: 'active', sort: 4, parentRoleId: null },
]

const PREFIX = 'documents/财务/'

beforeEach(() => {
  vi.clearAllMocks()
  listOrgRoles.mockResolvedValue(ROLES)
  listDocumentLibraries.mockResolvedValue([])
  previewDocumentLibrary.mockResolvedValue({
    pathPrefix: PREFIX,
    affectedFiles: 2,
    affectedMembers: 3,
  })
  createDocumentLibrary.mockResolvedValue({ id: 'lib-new' })
  putDocumentLibrary.mockResolvedValue({ id: 'lib-1' })
})

async function waitLoaded() {
  await waitFor(() => expect(listDocumentLibraries).toHaveBeenCalled())
  await waitFor(() => expect(screen.queryByText(/Loading/)).toBeNull())
}

function roleCheckbox(name: string) {
  return screen.getByRole('checkbox', { name })
}

describe('DocumentLibraryDialog', () => {
  it('refuses nested document prefixes and does not load rules', () => {
    render(
      <DocumentLibraryDialog prefix="documents/财务/工资/" open onOpenChange={() => {}} />,
    )
    expect(listDocumentLibraries).not.toHaveBeenCalled()
    expect(document.querySelector('[data-slot=dialog-content]')).toBeNull()
  })

  it('with no rule, explains open access and requires confirm before create', async () => {
    render(<DocumentLibraryDialog prefix={PREFIX} open onOpenChange={() => {}} />)
    await waitLoaded()

    expect(screen.getByText(/团队成员都能同步/)).toBeTruthy()

    fireEvent.click(roleCheckbox('财务'))
    fireEvent.click(screen.getByRole('button', { name: /保存|Save/ }))

    await waitFor(() => expect(previewDocumentLibrary).toHaveBeenCalledTimes(1))
    expect(previewDocumentLibrary.mock.calls[0][1]).toMatchObject({
      pathPrefix: PREFIX,
      roleIds: ['role-finance'],
    })
    expect(createDocumentLibrary).not.toHaveBeenCalled()

    expect(await screen.findByText(/3.*成员.*2.*文件/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /停止同步|Stop syncing/ }))

    await waitFor(() => expect(createDocumentLibrary).toHaveBeenCalledTimes(1))
    expect(createDocumentLibrary.mock.calls[0][1]).toMatchObject({
      pathPrefix: PREFIX,
      roleIds: ['role-finance'],
      confirmRevokeExisting: true,
    })
  })

  it('lists owner checked and disabled, hides member, shows admin and finance', async () => {
    render(<DocumentLibraryDialog prefix={PREFIX} open onOpenChange={() => {}} />)
    await waitLoaded()

    const owner = roleCheckbox('拥有者')
    expect(owner).toHaveProperty('disabled', true)
    expect(owner.getAttribute('data-state')).toBe('checked')

    expect(screen.queryByRole('checkbox', { name: '成员' })).toBeNull()
    expect(roleCheckbox('管理员')).toBeTruthy()
    expect(roleCheckbox('财务')).toBeTruthy()
  })

  it('actor-grant leftover saves via create, not put', async () => {
    listDocumentLibraries.mockResolvedValue([
      {
        id: 'acl-actors',
        pathPrefix: PREFIX,
        audience: 'actors',
        roles: [],
        actorIds: ['alice'],
      },
    ])
    previewDocumentLibrary.mockResolvedValue({
      pathPrefix: PREFIX,
      affectedFiles: 0,
      affectedMembers: 0,
    })

    render(<DocumentLibraryDialog prefix={PREFIX} open onOpenChange={() => {}} />)
    await waitLoaded()

    expect(screen.getByText(/当前仍按成员授权/)).toBeTruthy()

    fireEvent.click(roleCheckbox('财务'))
    fireEvent.click(screen.getByRole('button', { name: /保存|Save/ }))

    await waitFor(() => expect(createDocumentLibrary).toHaveBeenCalledTimes(1))
    expect(createDocumentLibrary.mock.calls[0][1]).toMatchObject({ pathPrefix: PREFIX })
    expect(putDocumentLibrary).not.toHaveBeenCalled()
  })

  it('existing role rule saves via put', async () => {
    listDocumentLibraries.mockResolvedValue([
      {
        id: 'acl-roles',
        pathPrefix: PREFIX,
        audience: 'roles',
        roles: [{ id: 'role-admin', code: 'admin', name: '管理员', status: 'active' }],
        actorIds: [],
      },
    ])
    previewDocumentLibrary.mockResolvedValue({
      pathPrefix: PREFIX,
      affectedFiles: 0,
      affectedMembers: 0,
    })

    render(<DocumentLibraryDialog prefix={PREFIX} open onOpenChange={() => {}} />)
    await waitLoaded()

    fireEvent.click(roleCheckbox('财务'))
    fireEvent.click(screen.getByRole('button', { name: /保存|Save/ }))

    await waitFor(() => expect(putDocumentLibrary).toHaveBeenCalledTimes(1))
    expect(putDocumentLibrary.mock.calls[0]).toEqual([
      'team-1',
      'acl-roles',
      expect.objectContaining({ roleIds: expect.arrayContaining(['role-finance', 'role-admin']) }),
    ])
    expect(createDocumentLibrary).not.toHaveBeenCalled()
  })

  it('skips confirm when preview reports no members losing access', async () => {
    previewDocumentLibrary.mockResolvedValue({
      pathPrefix: PREFIX,
      affectedFiles: 5,
      affectedMembers: 0,
    })

    render(<DocumentLibraryDialog prefix={PREFIX} open onOpenChange={() => {}} />)
    await waitLoaded()

    fireEvent.click(roleCheckbox('财务'))
    fireEvent.click(screen.getByRole('button', { name: /保存|Save/ }))

    await waitFor(() => expect(createDocumentLibrary).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: /停止同步|Stop syncing/ })).toBeNull()
  })

  it('lists a granted role that was deactivated so it can be kept or removed', async () => {
    listOrgRoles.mockResolvedValue([
      ...ROLES,
      { id: 'role-hr', orgId: 'org-1', name: '人事', code: 'hr', description: null, isSystem: false, status: 'inactive', sort: 5, parentRoleId: null },
    ])
    listDocumentLibraries.mockResolvedValue([
      {
        id: 'lib-1',
        pathPrefix: PREFIX,
        audience: 'roles',
        roles: [
          { id: 'role-owner', code: 'owner', name: '拥有者', status: 'active' },
          { id: 'role-finance', code: 'finance', name: '财务', status: 'active' },
          { id: 'role-hr', code: 'hr', name: '人事', status: 'inactive' },
        ],
        actorIds: [],
      },
    ])
    previewDocumentLibrary.mockResolvedValue({ pathPrefix: PREFIX, affectedFiles: 0, affectedMembers: 0 })

    render(<DocumentLibraryDialog prefix={PREFIX} open onOpenChange={() => {}} />)
    await waitLoaded()

    const hr = roleCheckbox('人事')
    expect(hr.getAttribute('data-state')).toBe('checked')
    expect(screen.getByText('已停用')).toBeTruthy()

    fireEvent.click(hr)
    fireEvent.click(screen.getByRole('button', { name: /保存|Save/ }))
    await waitFor(() => expect(putDocumentLibrary).toHaveBeenCalledTimes(1))
    expect(putDocumentLibrary.mock.calls[0][2]).toMatchObject({ roleIds: ['role-finance'] })
  })
})
