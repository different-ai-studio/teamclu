import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Lock, AlertTriangle } from 'lucide-react'
import { getBackend } from '@/lib/backend'
import { useCurrentTeamStore } from '@/stores/current-team'
import {
  isDocumentLibraryPrefix,
  type DocumentLibrary,
  type DocumentLibraryImpact,
} from '@/lib/backend/cloud-api/document-libraries'
import type { OrgRole } from '@/lib/backend/cloud-api/org-roles'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'

export function DocumentLibraryDialog({
  prefix,
  open,
  onOpenChange,
}: {
  prefix: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id) ?? null

  const [libraries, setLibraries] = React.useState<DocumentLibrary[] | null>(null)
  const [orgRoles, setOrgRoles] = React.useState<OrgRole[]>([])
  const [selectedRoleIds, setSelectedRoleIds] = React.useState<string[]>([])
  const [impact, setImpact] = React.useState<DocumentLibraryImpact | null>(null)
  const [awaitingConfirm, setAwaitingConfirm] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const validPrefix = isDocumentLibraryPrefix(prefix)

  const load = React.useCallback(async () => {
    if (!teamId || !open || !validPrefix) return
    setError(null)
    try {
      const [items, roles] = await Promise.all([
        getBackend().documentLibraries.listDocumentLibraries(teamId),
        getBackend().orgRoles.list(teamId),
      ])
      const own = items.find((r) => r.pathPrefix === prefix) ?? null
      const selectableIds =
        own?.audience === 'roles' ? own.roles.filter((r) => r.code !== 'owner').map((r) => r.id) : []
      setLibraries(items)
      setOrgRoles(roles)
      setSelectedRoleIds(selectableIds)
      setImpact(null)
      setAwaitingConfirm(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setLibraries([])
    }
  }, [teamId, open, validPrefix, prefix])

  React.useEffect(() => {
    void load()
  }, [load])

  if (!validPrefix) {
    return null
  }

  const ownRule = (libraries ?? []).find((r) => r.pathPrefix === prefix) ?? null
  const ownerRole = orgRoles.find((r) => r.code === 'owner' && r.status === 'active')
  // Roles already granted stay listed even when the picker would not offer
  // them now (deactivated, or `member`): the save sends back every selected
  // id, so a hidden one could be neither seen nor unchecked.
  const grantedIds = new Set(
    ownRule?.audience === 'roles' ? ownRule.roles.map((r) => r.id) : [],
  )
  const selectableRoles = orgRoles.filter(
    (r) =>
      r.code !== 'owner' &&
      ((r.status === 'active' && r.code !== 'member') || grantedIds.has(r.id)),
  )

  const roleIdsForSave = () => selectedRoleIds.filter((id) => id !== ownerRole?.id)

  const toggleRole = (roleId: string, checked: boolean) => {
    setSelectedRoleIds((prev) =>
      checked ? [...prev, roleId] : prev.filter((id) => id !== roleId),
    )
    setImpact(null)
    setAwaitingConfirm(false)
  }

  const write = async (confirmRevokeExisting: boolean) => {
    if (!teamId) throw new Error('No team selected.')
    const roleIds = roleIdsForSave()
    if (ownRule?.audience === 'roles') {
      await getBackend().documentLibraries.putDocumentLibrary(teamId, ownRule.id, {
        roleIds,
        ...(confirmRevokeExisting ? { confirmRevokeExisting: true } : {}),
      })
    } else {
      await getBackend().documentLibraries.createDocumentLibrary(teamId, {
        pathPrefix: prefix,
        roleIds,
        ...(confirmRevokeExisting ? { confirmRevokeExisting: true } : {}),
      })
    }
    onOpenChange(false)
  }

  const runSave = async () => {
    if (!teamId) return
    setBusy(true)
    setError(null)
    try {
      if (awaitingConfirm) {
        await write(true)
        return
      }
      const preview = await getBackend().documentLibraries.previewDocumentLibrary(teamId, {
        pathPrefix: prefix,
        roleIds: roleIdsForSave(),
      })
      setImpact(preview)
      if (preview.affectedMembers > 0 && preview.affectedFiles > 0) {
        setAwaitingConfirm(true)
        return
      }
      await write(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const removeRule = async () => {
    if (!teamId || !ownRule) return
    setBusy(true)
    setError(null)
    try {
      await getBackend().documentLibraries.deleteDocumentLibrary(teamId, ownRule.id)
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const dirName = prefix.replace(/\/$/, '').split('/').slice(1).join('/') || '/'
  const ownerLabel = ownerRole?.name ?? t('documentLibrary.owner', '拥有者')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-4 w-4" />
            {t('documentLibrary.title', '谁可以看')}
          </DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">{dirName}</DialogDescription>
        </DialogHeader>

        {libraries === null ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('common.loading', 'Loading…')}
          </div>
        ) : (
          <div className="flex flex-col gap-3 py-1">
            {!ownRule ? (
              <p className="text-sm text-muted-foreground">
                {t('documentLibrary.open', '这个文件夹目前团队成员都能同步。')}
              </p>
            ) : ownRule.audience === 'actors' ? (
              <p className="text-sm text-muted-foreground">
                {t(
                  'documentLibrary.actorLeftover',
                  '当前仍按成员授权。保存后会改成按角色，并替换原来的成员名单。',
                )}
              </p>
            ) : null}

            <div className="rounded-md border divide-y">
              <div className="flex items-center gap-3 px-3 py-2.5">
                <Checkbox id="doc-lib-owner" checked disabled aria-label={ownerLabel} />
                <Label htmlFor="doc-lib-owner" className="text-sm font-normal text-muted-foreground">
                  {ownerLabel}
                </Label>
              </div>
              {selectableRoles.map((role) => {
                const id = `doc-lib-role-${role.id}`
                const checked = selectedRoleIds.includes(role.id)
                return (
                  <div key={role.id} className="flex items-center gap-3 px-3 py-2.5">
                    <Checkbox
                      id={id}
                      checked={checked}
                      disabled={busy}
                      aria-label={role.name}
                      onCheckedChange={(v) => toggleRole(role.id, v === true)}
                    />
                    <Label htmlFor={id} className="text-sm font-normal">
                      {role.name}
                      {role.status !== 'active' && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {t('documentLibrary.inactiveRole', '已停用')}
                        </span>
                      )}
                    </Label>
                  </div>
                )
              })}
            </div>

            {impact && awaitingConfirm && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <p className="text-muted-foreground">
                  {t('documentLibrary.confirmBody', {
                    defaultValue:
                      '{{members}} 名成员将停止同步这个文件夹里的 {{files}} 个文件。已经拷走的文件收不回来。',
                    members: impact.affectedMembers,
                    files: impact.affectedFiles,
                  })}
                </p>
                <p className="mt-1 text-muted-foreground">
                  {t(
                    'documentLibrary.confirmCaveat',
                    'Files already copied away cannot be taken back.',
                  )}
                </p>
              </div>
            )}

            <div className="flex gap-2 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <p>
                {t(
                  'documentLibrary.scopeNotice',
                  'Removing access stops future syncing. It cannot take back copies already on someone’s device.',
                )}
              </p>
            </div>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter className="gap-2 sm:justify-between">
          <div>
            {ownRule && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void removeRule()}>
                {t('documentLibrary.remove', '改为团队可见')}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            {libraries !== null && (
              <Button
                variant={awaitingConfirm ? 'destructive' : 'default'}
                disabled={busy}
                onClick={() => void runSave()}
              >
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {awaitingConfirm
                  ? t('documentLibrary.confirmTitle', '停止同步')
                  : t('documentLibrary.save', '保存')}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
