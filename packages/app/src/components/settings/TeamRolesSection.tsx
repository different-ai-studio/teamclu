import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Pencil, Plus, Trash2, Users } from 'lucide-react'
import { getBackend } from '@/lib/backend'
import { CloudApiError } from '@/lib/backend/cloud-api/http'
import type { OrgRole, OrgRoleCreate, OrgRolePatch } from '@/lib/backend/cloud-api/org-roles'
import { useTeamPermissions } from '@/lib/team/team-permissions'
import { useCurrentTeamStore } from '@/stores/current-team'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SectionHeader, SettingCard } from './shared'

const CODE_RE = /^[a-z][a-z0-9_]*$/

/**
 * Org role catalog — Settings「团队管理」→ 团队角色.
 *
 * System roles (owner/admin/member/finance) are read-only. Custom roles are
 * CRUD'd via Cloud API `orgRoles`. Delete with member bindings returns 409
 * with `bindingCount` in the error details.
 */
export function TeamRolesSection() {
  const { t } = useTranslation()
  const { canManageTeam } = useTeamPermissions()
  const teamId = useCurrentTeamStore((s) => s.team?.id) ?? null

  const [roles, setRoles] = React.useState<OrgRole[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [draftName, setDraftName] = React.useState('')
  const [draftCode, setDraftCode] = React.useState('')
  const [draftDescription, setDraftDescription] = React.useState('')
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [editName, setEditName] = React.useState('')
  const [editDescription, setEditDescription] = React.useState('')
  const [editStatus, setEditStatus] = React.useState<'active' | 'inactive'>('active')
  const [editSort, setEditSort] = React.useState(50)

  const load = React.useCallback(async () => {
    if (!teamId) return
    setError(null)
    try {
      const items = await getBackend().orgRoles.list(teamId)
      setRoles([...items].sort((a, b) =>
        Number(b.isSystem) - Number(a.isSystem) || a.sort - b.sort || a.code.localeCompare(b.code)))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setRoles([])
    }
  }, [teamId])

  React.useEffect(() => {
    void load()
  }, [load])

  const startEdit = (role: OrgRole) => {
    setEditingId(role.id)
    setEditName(role.name)
    setEditDescription(role.description ?? '')
    setEditStatus(role.status === 'inactive' ? 'inactive' : 'active')
    setEditSort(role.sort)
    setError(null)
  }

  const cancelEdit = () => {
    setEditingId(null)
  }

  const submitCreate = async () => {
    if (!teamId || !canManageTeam) return
    const name = draftName.trim()
    const code = draftCode.trim()
    if (!name || !CODE_RE.test(code)) {
      setError(
        t(
          'settings.teamRoles.invalidCode',
          'Code must start with a letter and use only lowercase letters, digits, and underscores.',
        ),
      )
      return
    }
    setBusy(true)
    setError(null)
    try {
      const input: OrgRoleCreate = { name, code }
      const desc = draftDescription.trim()
      if (desc) input.description = desc
      await getBackend().orgRoles.create(teamId, input)
      setCreating(false)
      setDraftName('')
      setDraftCode('')
      setDraftDescription('')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const submitEdit = async (roleId: string) => {
    if (!teamId || !canManageTeam) return
    const name = editName.trim()
    if (!name) return
    setBusy(true)
    setError(null)
    try {
      const patch: OrgRolePatch = {
        name,
        description: editDescription.trim() || null,
        status: editStatus,
        sort: editSort,
      }
      await getBackend().orgRoles.patch(teamId, roleId, patch)
      setEditingId(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const submitDelete = async (role: OrgRole) => {
    if (!teamId || !canManageTeam || role.isSystem) return
    setBusy(true)
    setError(null)
    try {
      await getBackend().orgRoles.remove(teamId, role.id)
      await load()
    } catch (e) {
      if (e instanceof CloudApiError && e.status === 409) {
        const count = typeof e.details?.bindingCount === 'number' ? e.details.bindingCount : null
        setError(
          count != null
            ? t(
                'settings.teamRoles.deleteBound',
                'Cannot delete: {{count}} member binding(s) still use this role.',
                { count },
              )
            : e.message,
        )
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setBusy(false)
    }
  }

  if (!teamId) {
    return (
      <div className="space-y-6">
        <SectionHeader
          icon={Users}
          title={t('settings.teamRoles.title', '团队角色')}
          description={t('settings.teamRoles.noTeam', 'Join or create a team to manage roles.')}
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="mb-2 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <SectionHeader
            icon={Users}
            title={t('settings.teamRoles.title', '团队角色')}
            description={t(
              'settings.teamRoles.description',
              'Org-scoped roles shared across teams in this organization. System roles cannot be edited.',
            )}
          />
        </div>
        {canManageTeam && !creating && (
          <Button
            size="sm"
            className="mt-1 shrink-0 bg-coral text-white hover:bg-coral/90"
            onClick={() => {
              setCreating(true)
              setError(null)
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('settings.teamRoles.newRole', '新建角色')}
          </Button>
        )}
      </div>

      {error && (
        <SettingCard>
          <p className="text-[12.5px] text-destructive" role="alert">
            {error}
          </p>
        </SettingCard>
      )}

      {creating && canManageTeam && (
        <SettingCard>
          <p className="mb-3 text-[13px] font-semibold">{t('settings.teamRoles.createTitle', '新建角色')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-[11.5px] text-muted-foreground">{t('settings.teamRoles.name', '名称')}</span>
              <Input
                aria-label={t('settings.teamRoles.name', '名称')}
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                disabled={busy}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11.5px] text-muted-foreground">{t('settings.teamRoles.code', '代码')}</span>
              <Input
                aria-label={t('settings.teamRoles.code', '代码')}
                className="font-mono text-[12px]"
                value={draftCode}
                onChange={(e) => setDraftCode(e.target.value)}
                placeholder="auditor"
                disabled={busy}
              />
            </label>
            <label className="block space-y-1 sm:col-span-2">
              <span className="text-[11.5px] text-muted-foreground">
                {t('settings.teamRoles.descriptionField', '描述')}
              </span>
              <Input
                aria-label={t('settings.teamRoles.descriptionField', '描述')}
                value={draftDescription}
                onChange={(e) => setDraftDescription(e.target.value)}
                disabled={busy}
              />
            </label>
          </div>
          <div className="mt-4 flex gap-2">
            <Button
              size="sm"
              className="bg-coral text-white hover:bg-coral/90"
              disabled={busy}
              onClick={() => void submitCreate()}
            >
              {t('settings.teamRoles.create', '创建')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setCreating(false)
                setDraftName('')
                setDraftCode('')
                setDraftDescription('')
              }}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
          </div>
        </SettingCard>
      )}

      {roles === null ? (
        <SettingCard>
          <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('common.loading', 'Loading…')}
          </div>
        </SettingCard>
      ) : roles.length === 0 ? (
        <SettingCard>
          <p className="text-[12.5px] text-muted-foreground">
            {t('settings.teamRoles.empty', 'No roles yet.')}
          </p>
        </SettingCard>
      ) : (
        <div className="space-y-2">
          {roles.map((role) => {
            const isEditing = editingId === role.id
            return (
              <SettingCard key={role.id} className="p-4" data-testid={`org-role-row-${role.id}`}>
                {isEditing ? (
                  <div className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="block space-y-1">
                        <span className="text-[11.5px] text-muted-foreground">
                          {t('settings.teamRoles.name', '名称')}
                        </span>
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          disabled={busy}
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className="text-[11.5px] text-muted-foreground">
                          {t('settings.teamRoles.status', '状态')}
                        </span>
                        <select
                          className="flex h-9 w-full rounded-md border border-border bg-paper px-3 text-[13px]"
                          value={editStatus}
                          onChange={(e) =>
                            setEditStatus(e.target.value === 'inactive' ? 'inactive' : 'active')
                          }
                          disabled={busy}
                        >
                          <option value="active">{t('settings.teamRoles.statusActive', 'active')}</option>
                          <option value="inactive">{t('settings.teamRoles.statusInactive', 'inactive')}</option>
                        </select>
                      </label>
                      <label className="block space-y-1 sm:col-span-2">
                        <span className="text-[11.5px] text-muted-foreground">
                          {t('settings.teamRoles.descriptionField', '描述')}
                        </span>
                        <Input
                          value={editDescription}
                          onChange={(e) => setEditDescription(e.target.value)}
                          disabled={busy}
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className="text-[11.5px] text-muted-foreground">
                          {t('settings.teamRoles.sort', '排序')}
                        </span>
                        <Input
                          type="number"
                          value={editSort}
                          onChange={(e) => setEditSort(Number(e.target.value) || 0)}
                          disabled={busy}
                        />
                      </label>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        className="bg-coral text-white hover:bg-coral/90"
                        disabled={busy}
                        onClick={() => void submitEdit(role.id)}
                      >
                        {t('common.save', 'Save')}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={cancelEdit}>
                        {t('common.cancel', 'Cancel')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px] font-semibold">{role.name}</span>
                        <span className="font-mono text-[11px] text-faint">{role.code}</span>
                        {role.isSystem && (
                          <span className="rounded border border-border-soft bg-panel px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wide text-faint">
                            {t('settings.teamRoles.system', '系统')}
                          </span>
                        )}
                        <span className="font-mono text-[11px] text-muted-foreground">{role.status}</span>
                      </div>
                      {role.description ? (
                        <p className="text-[12.5px] text-muted-foreground">{role.description}</p>
                      ) : null}
                    </div>
                    {canManageTeam && !role.isSystem && (
                      <div className="flex shrink-0 gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          aria-label={t('settings.teamRoles.edit', '编辑')}
                          onClick={() => startEdit(role)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          aria-label={t('settings.teamRoles.delete', '删除')}
                          onClick={() => void submitDelete(role)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </SettingCard>
            )
          })}
        </div>
      )}
    </div>
  )
}
