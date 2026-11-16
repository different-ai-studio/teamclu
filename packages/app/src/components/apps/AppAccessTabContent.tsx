import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Check, ChevronDown, Loader2, Shield, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { getBackend } from '@/lib/backend'
import { useAppsStore } from '@/stores/apps-store'
import { AppTabShell } from './AppTabShell'
import type {
  AppAccessCandidate,
  AppMemberAccessRow,
  AppPermissionLevel,
  AppRow,
} from '@/lib/backend/types'

const PERMISSION_LEVELS: AppPermissionLevel[] = ['read', 'write', 'admin']

/**
 * Who on the team may work on this app.
 *
 * Moved out of the control panel, which had it as a 280px-wide stack of a
 * dropdown, a delete button and a second dropdown to grant with. The list is a
 * table of people; a table needs a row, and a row needs width.
 *
 * Not to be confused with the app permissions tab, which is about who on the
 * internet may open the deployed site. This one is about the workspace.
 *
 * Grantees are members and agents alike: an agent has its own account and no
 * access by default, so this is also where an agent is let in to push. An
 * agent whose daemon has not claimed an account yet is listed but cannot be
 * picked — the grant would name nobody who can act on it.
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
  const [members, setMembers] = React.useState<AppAccessCandidate[]>([])
  const [rows, setRows] = React.useState<AppMemberAccessRow[] | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [canManage, setCanManage] = React.useState(false)
  const [grantMemberId, setGrantMemberId] = React.useState('')
  const [grantLevel, setGrantLevel] = React.useState<AppPermissionLevel>('write')
  const [memberPickerOpen, setMemberPickerOpen] = React.useState(false)
  const invalidateAppSummary = useAppsStore((s) => s.invalidateAppSummary)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const [teamMembers, grants] = await Promise.all([
        getBackend().actors.listTeamActorsForAppAccess(app.teamId),
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
  const isAgent = React.useCallback(
    (row: AppMemberAccessRow) =>
      row.actorType === 'agent' || members.find((m) => m.id === row.memberId)?.actorType === 'agent',
    [members],
  )

  // Never the app's own creator: they are admin by construction.
  const candidates = React.useMemo(
    () =>
      members.filter(
        (m) => m.id !== app.createdByActorId && !rows?.some((row) => row.memberId === m.id),
      ),
    [members, rows, app.createdByActorId],
  )
  const pickable = React.useMemo(() => candidates.filter((m) => m.connected), [candidates])
  const agentsToGrant = React.useMemo(
    () => candidates.filter((m) => m.actorType === 'agent' && m.connected),
    [candidates],
  )

  React.useEffect(() => {
    if (pickable.length === 0) {
      setGrantMemberId('')
      return
    }
    if (!pickable.some((m) => m.id === grantMemberId)) {
      setGrantMemberId(pickable[0]?.id ?? '')
    }
  }, [pickable, grantMemberId])

  const failed = (e: unknown) =>
    toast.error(t('apps.controlPanel.accessError', '权限操作失败'), {
      description: e instanceof Error ? e.message : String(e),
    })

  const grant = async (memberId = grantMemberId, level = grantLevel) => {
    if (!memberId || !canManage) return
    setSaving(true)
    try {
      const row = await getBackend().apps.setAppAccess(app.id, memberId, level)
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
            'read 可查看和下载代码；write 可改代码；admin 可部署和授权。权限会同步到 Git 仓库，agent 和成员一样需要单独授权。',
          )}
        </span>
      </div>

      {rows && rows.length > 0 ? (
        <ul className="divide-y divide-border-soft rounded-lg border border-border-soft">
          {rows.map((row) => (
            <li key={row.memberId} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-foreground">
                <span className="truncate">{memberName(row.memberId)}</span>
                {isAgent(row) && <AgentBadge />}
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

      {agentsToGrant.length > 0 && (
        <div className="space-y-2 border-t border-border-soft pt-4" data-testid="app-access-quick-agents">
          <p className="text-[12.5px] text-muted-foreground">
            {t('apps.controlPanel.quickGrantAgents', '授权给 agent')}
          </p>
          <ul className="flex flex-wrap gap-2">
            {agentsToGrant.map((agent) => (
              <li key={agent.id}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 rounded-[7px] text-[12.5px]"
                  disabled={saving}
                  onClick={() => void grant(agent.id, 'write')}
                  data-testid={`app-access-quick-grant-${agent.id}`}
                  title={t('apps.controlPanel.quickGrantWrite', '授予 write')}
                >
                  <Bot className="h-3.5 w-3.5" />
                  {agent.displayName}
                  <span className="font-mono text-[11px] text-muted-foreground">write</span>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {candidates.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border-soft pt-4">
          <Popover open={memberPickerOpen} onOpenChange={setMemberPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                role="combobox"
                aria-expanded={memberPickerOpen}
                data-testid="app-access-member-picker"
                disabled={saving}
                className="h-9 min-w-[180px] flex-1 justify-between rounded-[7px] px-3 text-[13px] font-normal"
              >
                <span className="truncate">
                  {pickable.find((m) => m.id === grantMemberId)?.displayName ??
                    t('apps.controlPanel.pickMember', '选择成员或 agent')}
                </span>
                <ChevronDown className="h-4 w-4 shrink-0 text-faint" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
              <Command>
                <CommandInput placeholder={t('apps.controlPanel.searchMember', '搜索成员…')} />
                <CommandList>
                  <CommandEmpty>{t('apps.controlPanel.noMatchingMembers', '没有匹配的成员')}</CommandEmpty>
                  {candidates.map((m) => (
                    <CommandItem
                      key={m.id}
                      value={m.id}
                      keywords={[m.displayName]}
                      disabled={!m.connected}
                      onSelect={() => {
                        if (!m.connected) return
                        setGrantMemberId(m.id)
                        setMemberPickerOpen(false)
                      }}
                      title={
                        m.connected
                          ? undefined
                          : t('apps.controlPanel.agentNotConnected', '这个 agent 还没连上，连上后才能授权')
                      }
                      className="text-[13px]"
                    >
                      <Check className={m.id === grantMemberId ? 'opacity-100' : 'opacity-0'} />
                      <span className="truncate">{m.displayName}</span>
                      {m.actorType === 'agent' && <AgentBadge />}
                    </CommandItem>
                  ))}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
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

function AgentBadge() {
  const { t } = useTranslation()
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-[5px] bg-surface-2 px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
      <Bot className="h-3 w-3" />
      {t('apps.controlPanel.agentBadge', 'agent')}
    </span>
  )
}
