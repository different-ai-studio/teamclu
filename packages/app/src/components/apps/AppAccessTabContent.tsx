import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Shield, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { getBackend } from '@/lib/backend'
import { useAppsStore } from '@/stores/apps-store'
import { listTeamMembersForAccess, type TeamMemberOption } from '@/lib/daemon/daemon-agent-admin'
import { AppTabShell } from './AppTabShell'
import type { AppMemberAccessRow, AppPermissionLevel, AppRow } from '@/lib/backend/types'

const PERMISSION_LEVELS: AppPermissionLevel[] = ['view', 'prompt', 'admin']

/**
 * Who on the team may work on this app.
 *
 * Moved out of the control panel, which had it as a 280px-wide stack of a
 * dropdown, a delete button and a second dropdown to grant with. The list is a
 * table of people; a table needs a row, and a row needs width.
 *
 * Not to be confused with the app permissions tab, which is about who on the
 * internet may open the deployed site. This one is about the workspace.
 */
export function AppAccessTabContent({ appId }: { appId: string }) {
  const { t } = useTranslation()
  return (
    <AppTabShell
      appId={appId}
      title={t('apps.access.tabTitle', '协作权限')}
      description={t(
        'apps.access.tabDescription',
        '团队里谁能改这个应用。跟线上站点的登录无关 —— 那在「应用权限」。',
      )}
    >
      {(app) => <AccessBody app={app} />}
    </AppTabShell>
  )
}

function AccessBody({ app }: { app: AppRow }) {
  const { t } = useTranslation()
  const [members, setMembers] = React.useState<TeamMemberOption[]>([])
  const [rows, setRows] = React.useState<AppMemberAccessRow[] | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [canManage, setCanManage] = React.useState(false)
  const [grantMemberId, setGrantMemberId] = React.useState('')
  const [grantLevel, setGrantLevel] = React.useState<AppPermissionLevel>('prompt')
  const invalidateAppSummary = useAppsStore((s) => s.invalidateAppSummary)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const [teamMembers, grants] = await Promise.all([
        listTeamMembersForAccess(app.teamId),
        getBackend().apps.listAppAccess(app.id),
      ])
      setMembers(teamMembers)
      setRows(grants ?? [])
      // Null is 404, which is also what a member without `admin` is told: the
      // ability to READ the grant list is the same permission as changing it.
      setCanManage(grants !== null)
    } catch (e) {
      console.error('[AppAccessTab] failed to load access', e)
      setMembers([])
      setRows([])
      setCanManage(false)
    } finally {
      setLoading(false)
    }
  }, [app.id, app.teamId])

  React.useEffect(() => {
    void load()
  }, [load])

  const memberName = React.useCallback(
    (memberId: string) => members.find((m) => m.id === memberId)?.displayName ?? memberId,
    [members],
  )

  const candidates = React.useMemo(
    () => members.filter((m) => !rows?.some((row) => row.memberId === m.id)),
    [members, rows],
  )

  React.useEffect(() => {
    if (candidates.length === 0) {
      setGrantMemberId('')
      return
    }
    if (!candidates.some((m) => m.id === grantMemberId)) {
      setGrantMemberId(candidates[0]?.id ?? '')
    }
  }, [candidates, grantMemberId])

  const failed = (e: unknown) =>
    toast.error(t('apps.controlPanel.accessError', '权限操作失败'), {
      description: e instanceof Error ? e.message : String(e),
    })

  const grant = async () => {
    if (!grantMemberId || !canManage) return
    setSaving(true)
    try {
      const row = await getBackend().apps.setAppAccess(app.id, grantMemberId, grantLevel)
      if (row) {
        setRows((prev) => {
          const list = prev ?? []
          const idx = list.findIndex((r) => r.memberId === row.memberId)
          if (idx < 0) return [...list, row]
          const next = [...list]
          next[idx] = row
          return next
        })
        toast.success(t('apps.controlPanel.accessGranted', '已授权'))
        invalidateAppSummary()
      }
    } catch (e) {
      failed(e)
    } finally {
      setSaving(false)
    }
  }

  const update = async (memberId: string, level: AppPermissionLevel) => {
    setSaving(true)
    try {
      const row = await getBackend().apps.setAppAccess(app.id, memberId, level)
      if (row) setRows((prev) => (prev ?? []).map((r) => (r.memberId === memberId ? row : r)))
    } catch (e) {
      failed(e)
    } finally {
      setSaving(false)
    }
  }

  const revoke = async (memberId: string) => {
    setSaving(true)
    try {
      const ok = await getBackend().apps.removeAppAccess(app.id, memberId)
      if (ok) {
        setRows((prev) => (prev ?? []).filter((r) => r.memberId !== memberId))
        toast.success(t('apps.controlPanel.accessRevoked', '已撤销'))
        invalidateAppSummary()
      }
    } catch (e) {
      failed(e)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-[13px] text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('common.loading', 'Loading…')}
      </div>
    )
  }

  if (!canManage) {
    return (
      <p className="text-[13px] text-muted-foreground" data-testid="app-access-readonly">
        {t('apps.controlPanel.permissionsReadOnly', '仅创建者或 admin 可管理成员权限。')}
      </p>
    )
  }

  return (
    <div className="space-y-5" data-testid="app-access-tab">
      <div className="flex items-start gap-2 rounded-lg border border-border-soft bg-surface-2/40 px-3 py-2.5 text-[12.5px] text-muted-foreground">
        <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          {t(
            'apps.controlPanel.permissionsHint',
            'view 仅可见；prompt 可协作改代码；admin 可部署与授权。',
          )}
        </span>
      </div>

      {rows && rows.length > 0 ? (
        <ul className="divide-y divide-border-soft rounded-lg border border-border-soft">
          {rows.map((row) => (
            <li key={row.memberId} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                {memberName(row.memberId)}
              </span>
              <Select
                value={row.permissionLevel}
                onValueChange={(v) => void update(row.memberId, v as AppPermissionLevel)}
                disabled={saving}
              >
                <SelectTrigger className="h-8 w-[110px] shrink-0 rounded-[7px] font-mono text-[11.5px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PERMISSION_LEVELS.map((level) => (
                    <SelectItem key={level} value={level} className="font-mono text-[11.5px]">
                      {t(`apps.controlPanel.permission.${level}`, level)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-muted-foreground"
                disabled={saving}
                onClick={() => void revoke(row.memberId)}
                title={t('apps.controlPanel.revokeAccess', '撤销')}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted-foreground" data-testid="app-access-empty">
          {t('apps.controlPanel.noAccessRows', '尚未授权其他成员')}
        </p>
      )}

      {candidates.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border-soft pt-4">
          <Select value={grantMemberId} onValueChange={setGrantMemberId} disabled={saving}>
            <SelectTrigger className="h-9 min-w-[180px] flex-1 rounded-[7px] text-[13px]">
              <SelectValue placeholder={t('apps.controlPanel.pickMember', '选择成员')} />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={grantLevel}
            onValueChange={(v) => setGrantLevel(v as AppPermissionLevel)}
            disabled={saving}
          >
            <SelectTrigger className="h-9 w-[110px] rounded-[7px] font-mono text-[11.5px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERMISSION_LEVELS.map((level) => (
                <SelectItem key={level} value={level} className="font-mono text-[11.5px]">
                  {t(`apps.controlPanel.permission.${level}`, level)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            className="h-9 rounded-[7px] text-[13px]"
            disabled={saving || !grantMemberId}
            onClick={() => void grant()}
            data-testid="app-access-grant"
          >
            {t('apps.controlPanel.grantAccess', '授权')}
          </Button>
        </div>
      )}
    </div>
  )
}
