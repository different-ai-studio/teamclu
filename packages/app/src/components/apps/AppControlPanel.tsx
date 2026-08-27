import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  Save,
  Trash2,
  FolderInput,
  Shield,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import { getBackend } from '@/lib/backend'
import { listTeamMembersForAccess, type TeamMemberOption } from '@/lib/daemon-agent-admin'
import { appStatusMeta, canReseed } from '@/lib/app-list-helpers'
import { daemonAppWorkdir, moveDaemonAppWorkdir } from '@/lib/daemon-local-client'
import { isTauri } from '@/lib/utils'
import { useAppsStore } from '@/stores/apps-store'
import type { AppAuthMode, AppMemberAccessRow, AppPermissionLevel, AppRow } from '@/lib/backend/types'

const AUTH_MODES: AppAuthMode[] = ['none', 'platform', 'third']
const PERMISSION_LEVELS: AppPermissionLevel[] = ['view', 'prompt', 'admin']

function StatusDot({ tone }: { tone: 'live' | 'ready' | 'failed' | 'idle' }) {
  const color =
    tone === 'live'
      ? 'bg-[#2eb872]'
      : tone === 'failed'
        ? 'bg-destructive'
        : tone === 'ready'
          ? 'bg-[#2eb872]/70'
          : 'bg-[#e8b54a]'
  return <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', color)} />
}

function SectionCard({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-[14px] border border-border bg-paper px-3.5 py-3">
      <h3 className="mb-2.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
        {title}
      </h3>
      {children}
    </section>
  )
}

interface AppControlPanelProps {
  app: AppRow
}

export function AppControlPanel({ app }: AppControlPanelProps) {
  const { t } = useTranslation()
  const deploying = useAppsStore((s) => s.deployingIds.includes(app.id))
  // From the row, not from local state: an in-memory list vanished on reload and
  // never existed for a second admin or another device, so the app looked
  // protected while the live site was still public (design §7.4).
  const pendingRedeploy = app.authModePendingRedeploy
  const reseed = useAppsStore((s) => s.reseed)
  const rename = useAppsStore((s) => s.rename)
  const updateAuthMode = useAppsStore((s) => s.updateAuthMode)
  const deploy = useAppsStore((s) => s.deploy)
  const deleteApp = useAppsStore((s) => s.deleteApp)

  const [nameDraft, setNameDraft] = React.useState(app.name)
  const [renaming, setRenaming] = React.useState(false)
  const [reseeding, setReseeding] = React.useState(false)
  const [authModeDraft, setAuthModeDraft] = React.useState<AppAuthMode>(app.authMode)
  const [authModeSaving, setAuthModeSaving] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)

  const [members, setMembers] = React.useState<TeamMemberOption[]>([])
  const [accessRows, setAccessRows] = React.useState<AppMemberAccessRow[] | null>(null)
  const [accessLoading, setAccessLoading] = React.useState(false)
  const [accessSaving, setAccessSaving] = React.useState(false)
  const [canManageAccess, setCanManageAccess] = React.useState(false)
  const [grantMemberId, setGrantMemberId] = React.useState('')
  const [grantLevel, setGrantLevel] = React.useState<AppPermissionLevel>('prompt')

  const [localWorkdir, setLocalWorkdir] = React.useState<string | null>(null)
  const [localDeviceName, setLocalDeviceName] = React.useState<string | null>(null)
  const [localPathLoading, setLocalPathLoading] = React.useState(false)
  const [moveOpen, setMoveOpen] = React.useState(false)
  const [moveDest, setMoveDest] = React.useState('')
  const [moving, setMoving] = React.useState(false)

  React.useEffect(() => {
    setNameDraft(app.name)
  }, [app.id, app.name])

  React.useEffect(() => {
    setAuthModeDraft(app.authMode)
  }, [app.id, app.authMode])

  const status = appStatusMeta(app, deploying)
  const deployUrl = app.publicUrl ?? app.fcEndpoint
  const showReseed = canReseed(app.provisionStatus)
  const authModeDirty = authModeDraft !== app.authMode
  const showAuthModePending = pendingRedeploy

  const loadAccess = React.useCallback(async () => {
    setAccessLoading(true)
    try {
      const [teamMembers, grants] = await Promise.all([
        listTeamMembersForAccess(app.teamId),
        getBackend().apps.listAppAccess(app.id),
      ])
      setMembers(teamMembers)
      setAccessRows(grants ?? [])
      setCanManageAccess(grants !== null)
    } catch (e) {
      console.error('[AppControlPanel] failed to load access', e)
      setMembers([])
      setAccessRows([])
      setCanManageAccess(false)
    } finally {
      setAccessLoading(false)
    }
  }, [app.id, app.teamId])

  React.useEffect(() => {
    void loadAccess()
  }, [loadAccess])

  const loadLocalPath = React.useCallback(async () => {
    if (!isTauri()) {
      setLocalWorkdir(null)
      setLocalDeviceName(null)
      return
    }
    setLocalPathLoading(true)
    try {
      const info = await daemonAppWorkdir(app.id, app.teamId)
      setLocalWorkdir(info?.workdir ?? null)
      setLocalDeviceName(info?.deviceName ?? null)
    } catch (e) {
      console.error('[AppControlPanel] failed to load local path', e)
      setLocalWorkdir(null)
      setLocalDeviceName(null)
    } finally {
      setLocalPathLoading(false)
    }
  }, [app.id, app.teamId])

  React.useEffect(() => {
    void loadLocalPath()
  }, [loadLocalPath])

  const memberName = React.useCallback(
    (memberId: string) => members.find((m) => m.id === memberId)?.displayName ?? memberId,
    [members],
  )

  const grantCandidates = React.useMemo(
    () => members.filter((m) => !accessRows?.some((row) => row.memberId === m.id)),
    [members, accessRows],
  )

  React.useEffect(() => {
    if (grantCandidates.length === 0) {
      setGrantMemberId('')
      return
    }
    if (!grantCandidates.some((m) => m.id === grantMemberId)) {
      setGrantMemberId(grantCandidates[0]?.id ?? '')
    }
  }, [grantCandidates, grantMemberId])

  const handleCopyUrl = async () => {
    if (!deployUrl) return
    try {
      await navigator.clipboard.writeText(deployUrl)
      toast.success(t('apps.urlCopied', '部署地址已复制'))
    } catch {
      toast.error(t('apps.urlCopyFailed', 'Failed to copy deployed URL'))
    }
  }

  const handleOpenUrl = async () => {
    if (!deployUrl) return
    try {
      const { open } = await import('@tauri-apps/plugin-shell')
      await open(deployUrl)
    } catch {
      window.open(deployUrl, '_blank', 'noopener,noreferrer')
    }
  }

  const handleRename = async () => {
    const trimmed = nameDraft.trim()
    if (!trimmed || trimmed === app.name) return
    setRenaming(true)
    try {
      await rename(app.id, trimmed)
    } finally {
      setRenaming(false)
    }
  }

  const handleReseed = async () => {
    setReseeding(true)
    try {
      await reseed(app.id)
    } finally {
      setReseeding(false)
    }
  }

  const handleSaveAuthMode = async () => {
    if (!authModeDirty) return
    setAuthModeSaving(true)
    try {
      await updateAuthMode(app.id, authModeDraft)
    } finally {
      setAuthModeSaving(false)
    }
  }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      const ok = await deleteApp(app.id)
      if (ok) setDeleteOpen(false)
    } finally {
      setDeleting(false)
    }
  }

  const handleGrant = async () => {
    if (!grantMemberId || !canManageAccess) return
    setAccessSaving(true)
    try {
      const row = await getBackend().apps.setAppAccess(app.id, grantMemberId, grantLevel)
      if (row) {
        setAccessRows((prev) => {
          const list = prev ?? []
          const idx = list.findIndex((r) => r.memberId === row.memberId)
          if (idx >= 0) {
            const next = [...list]
            next[idx] = row
            return next
          }
          return [...list, row]
        })
        toast.success(t('apps.controlPanel.accessGranted', '已授权'))
      }
    } catch (e) {
      toast.error(t('apps.controlPanel.accessError', '权限操作失败'), {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setAccessSaving(false)
    }
  }

  const handleUpdateAccess = async (memberId: string, level: AppPermissionLevel) => {
    setAccessSaving(true)
    try {
      const row = await getBackend().apps.setAppAccess(app.id, memberId, level)
      if (row) {
        setAccessRows((prev) =>
          (prev ?? []).map((r) => (r.memberId === memberId ? row : r)),
        )
      }
    } catch (e) {
      toast.error(t('apps.controlPanel.accessError', '权限操作失败'), {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setAccessSaving(false)
    }
  }

  const handleMovePickFolder = async () => {
    if (!isTauri()) return
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('apps.controlPanel.moveDirectoryPick', '选择新的应用目录'),
      })
      if (typeof selected === 'string' && selected.trim()) {
        setMoveDest(selected.trim())
      }
    } catch (e) {
      toast.error(t('apps.controlPanel.moveDirectoryError', '移动目录失败'), {
        description: e instanceof Error ? e.message : String(e),
      })
    }
  }

  const handleMoveConfirm = async () => {
    const dest = moveDest.trim()
    if (!dest) return
    setMoving(true)
    try {
      const result = await moveDaemonAppWorkdir(app.id, app.teamId, dest)
      if (result.outcome === 'moved') {
        setLocalWorkdir(result.workdir)
        // Re-bind the cloud workspace row too, not just local state. That row
        // is what runtime-start resolves to a path (see app-session.ts), so
        // leaving it on the old directory means any session already open keeps
        // running the agent against a path that no longer exists — until some
        // later session-open happens to re-bind it.
        if (result.workdir) {
          const { bindAppWorkdir } = await import('@/lib/app-session')
          await bindAppWorkdir(app, result.workdir)
        }
        setMoveOpen(false)
        setMoveDest('')
        toast.success(t('apps.controlPanel.moveDirectoryDone', '目录已移动'))
      } else if (result.outcome === 'unreachable') {
        toast.error(t('apps.controlPanel.moveDirectoryUnreachable', '无法连接本机 daemon'))
      } else {
        toast.error(t('apps.controlPanel.moveDirectoryError', '移动目录失败'), {
          description: result.error ?? undefined,
        })
      }
    } finally {
      setMoving(false)
    }
  }

  const handleRevoke = async (memberId: string) => {
    setAccessSaving(true)
    try {
      const ok = await getBackend().apps.removeAppAccess(app.id, memberId)
      if (ok) {
        setAccessRows((prev) => (prev ?? []).filter((r) => r.memberId !== memberId))
        toast.success(t('apps.controlPanel.accessRevoked', '已撤销'))
      }
    } catch (e) {
      toast.error(t('apps.controlPanel.accessError', '权限操作失败'), {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setAccessSaving(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="shrink-0 border-b border-border-soft px-3.5 py-3">
        <div className="flex items-center gap-2">
          <StatusDot tone={status.dot} />
          <h2 className="min-w-0 truncate text-[13px] font-semibold text-foreground">
            {app.name}
          </h2>
        </div>
        <p className="mt-1 font-mono text-[11px] text-faint">
          {t(status.key, status.fallback)}
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        <SectionCard title={t('apps.controlPanel.deployUrl', '部署地址')}>
          {deployUrl ? (
            <div className="space-y-2">
              <p className="break-all font-mono text-[11.5px] text-ink-2">{deployUrl}</p>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 rounded-[7px] text-[12px]"
                  onClick={() => void handleCopyUrl()}
                >
                  <Copy className="h-3 w-3" />
                  {t('apps.copyUrl', 'Copy deployed URL')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 rounded-[7px] text-[12px]"
                  onClick={() => void handleOpenUrl()}
                >
                  <ExternalLink className="h-3 w-3" />
                  {t('apps.openUrl', 'Open deployed URL')}
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-[12.5px] text-muted-foreground">
              {t('apps.controlPanel.noDeployUrl', '尚未部署，暂无线上地址')}
            </p>
          )}
        </SectionCard>

        <SectionCard title={t('apps.rename', 'Rename')}>
          <div className="flex gap-1.5">
            <Input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              className="h-8 flex-1 rounded-[7px] text-[13px]"
              disabled={renaming}
            />
            <Button
              type="button"
              size="sm"
              className="h-8 shrink-0 gap-1 rounded-[7px] px-2.5"
              disabled={renaming || !nameDraft.trim() || nameDraft.trim() === app.name}
              onClick={() => void handleRename()}
            >
              {renaming ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        </SectionCard>

        {showReseed && (
          <SectionCard title={t('apps.reseed', 'Reseed')}>
            <p className="mb-2 text-[12px] text-muted-foreground">
              {t(
                'apps.controlPanel.reseedHint',
                '重新写入模板或克隆仓库。仅在初始化失败或目录为空时使用。',
              )}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 rounded-[7px] text-[12px]"
              disabled={reseeding}
              onClick={() => void handleReseed()}
            >
              {reseeding ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {t('apps.reseed', 'Reseed')}
            </Button>
          </SectionCard>
        )}

        <SectionCard title={t('apps.controlPanel.localPath', '本机路径')}>
          {localPathLoading ? (
            <div className="flex items-center gap-2 py-1 text-[12.5px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('common.loading', 'Loading…')}
            </div>
          ) : !isTauri() ? (
            <p className="text-[12.5px] text-muted-foreground">
              {t('apps.controlPanel.localPathDesktopOnly', '本机路径仅在桌面客户端可用。')}
            </p>
          ) : localWorkdir ? (
            <div className="space-y-2">
              {localDeviceName ? (
                <p className="text-[12px] text-muted-foreground">
                  {t('apps.controlPanel.localPathOnDevice', '设备：{{name}}', {
                    name: localDeviceName,
                  })}
                </p>
              ) : null}
              <p
                className="break-all font-mono text-[11.5px] text-ink-2"
                data-testid="app-control-local-workdir"
              >
                {localWorkdir}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 rounded-[7px] text-[12px]"
                onClick={() => {
                  setMoveDest('')
                  setMoveOpen(true)
                }}
              >
                <FolderInput className="h-3.5 w-3.5" />
                {t('apps.controlPanel.moveDirectory', '移动目录')}
              </Button>
            </div>
          ) : (
            <p className="text-[12.5px] text-muted-foreground">
              {t(
                'apps.controlPanel.localPathUnavailable',
                '本机 daemon 未就绪，或此应用尚未在本机初始化目录。',
              )}
            </p>
          )}
        </SectionCard>

        <SectionCard title={t('apps.controlPanel.authMode', '登录方式')}>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Select
              value={authModeDraft}
              onValueChange={(v) => setAuthModeDraft(v as AppAuthMode)}
              disabled={authModeSaving}
            >
              <SelectTrigger
                className="h-8 w-full max-w-[220px] rounded-[7px] text-[12px]"
                data-testid="app-control-auth-mode"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUTH_MODES.map((mode) => (
                  <SelectItem
                    key={mode}
                    value={mode}
                    disabled={mode === 'third'}
                    className="text-[12px]"
                  >
                    {t(`apps.controlPanel.authModeOption.${mode}`, mode)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="sm"
              className="h-8 rounded-[7px] text-[12px]"
              disabled={authModeSaving || !authModeDirty || authModeDraft === 'third'}
              onClick={() => void handleSaveAuthMode()}
            >
              {authModeSaving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                t('common.save', 'Save')
              )}
            </Button>
            {showAuthModePending && (
              <span
                className="rounded-[7px] border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                data-testid="app-control-auth-pending-redeploy"
              >
                {t('apps.controlPanel.pendingRedeploy', '待重新部署')}
              </span>
            )}
          </div>
          {showAuthModePending && (
            <p
              className="mb-2 text-[12px] text-destructive"
              data-testid="app-control-auth-live-warning"
            >
              {t(
                'apps.controlPanel.authModeLiveWarning',
                '登录方式已保存，但线上站点仍运行旧配置。在重新部署之前，站点访问方式不会变（无登录的应用仍然对持有链接的人公开）。',
              )}
            </p>
          )}
          {authModeDraft === 'third' && (
            <p className="text-[12px] text-muted-foreground">
              {t(
                'apps.controlPanel.authModeThirdDisabled',
                '第三方登录暂不支持部署，请选择其他方式。',
              )}
            </p>
          )}
          {showAuthModePending && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2 h-8 gap-1.5 rounded-[7px] text-[12px]"
              disabled={deploying || app.provisionStatus !== 'ready'}
              onClick={() => void deploy(app.id)}
              data-testid="app-control-redeploy-now"
            >
              {deploying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {t('apps.controlPanel.redeployNow', '立即重新部署')}
            </Button>
          )}
        </SectionCard>

        <SectionCard title={t('apps.controlPanel.permissions', '成员权限')}>
          <div className="mb-2 flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Shield className="h-3.5 w-3.5 shrink-0" />
            <span>
              {t(
                'apps.controlPanel.permissionsHint',
                'view 仅可见；prompt 可协作改代码；admin 可部署与授权。',
              )}
            </span>
          </div>

          {accessLoading ? (
            <div className="flex items-center gap-2 py-2 text-[12.5px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('common.loading', 'Loading…')}
            </div>
          ) : !canManageAccess ? (
            <p
              className="text-[12.5px] text-muted-foreground"
              data-testid="app-control-permissions-readonly"
            >
              {t(
                'apps.controlPanel.permissionsReadOnly',
                '仅创建者或 admin 可管理成员权限。',
              )}
            </p>
          ) : (
            <>
              {accessRows && accessRows.length > 0 ? (
                <ul className="mb-3 space-y-1.5">
                  {accessRows.map((row) => (
                    <li
                      key={row.memberId}
                      className="flex items-center justify-between gap-2 rounded-lg border border-border-soft bg-background/40 px-2.5 py-2"
                    >
                      <span className="min-w-0 truncate text-[13px] text-foreground">
                        {memberName(row.memberId)}
                      </span>
                      <div className="flex shrink-0 items-center gap-1">
                        <Select
                          value={row.permissionLevel}
                          onValueChange={(v) =>
                            void handleUpdateAccess(row.memberId, v as AppPermissionLevel)
                          }
                          disabled={accessSaving}
                        >
                          <SelectTrigger className="h-7 w-[88px] rounded-[7px] font-mono text-[11px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {PERMISSION_LEVELS.map((level) => (
                              <SelectItem key={level} value={level} className="font-mono text-[11px]">
                                {t(`apps.controlPanel.permission.${level}`, level)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0 text-muted-foreground"
                          disabled={accessSaving}
                          onClick={() => void handleRevoke(row.memberId)}
                          title={t('apps.controlPanel.revokeAccess', '撤销')}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mb-3 text-[12.5px] text-muted-foreground">
                  {t('apps.controlPanel.noAccessRows', '尚未授权其他成员')}
                </p>
              )}

              {grantCandidates.length > 0 && (
                <div className="flex flex-wrap items-end gap-1.5 border-t border-border-soft pt-2.5">
                  <div className="min-w-[120px] flex-1">
                    <Select
                      value={grantMemberId}
                      onValueChange={setGrantMemberId}
                      disabled={accessSaving}
                    >
                      <SelectTrigger className="h-8 rounded-[7px] text-[12px]">
                        <SelectValue placeholder={t('apps.controlPanel.pickMember', '选择成员')} />
                      </SelectTrigger>
                      <SelectContent>
                        {grantCandidates.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.displayName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Select
                    value={grantLevel}
                    onValueChange={(v) => setGrantLevel(v as AppPermissionLevel)}
                    disabled={accessSaving}
                  >
                    <SelectTrigger className="h-8 w-[88px] rounded-[7px] font-mono text-[11px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PERMISSION_LEVELS.map((level) => (
                        <SelectItem key={level} value={level} className="font-mono text-[11px]">
                          {t(`apps.controlPanel.permission.${level}`, level)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 rounded-[7px] text-[12px]"
                    disabled={accessSaving || !grantMemberId}
                    onClick={() => void handleGrant()}
                  >
                    {t('apps.controlPanel.grantAccess', '授权')}
                  </Button>
                </div>
              )}
            </>
          )}
        </SectionCard>

        <SectionCard title={t('apps.delete', 'Delete')}>
          <p className="mb-2 text-[12px] text-muted-foreground">
            {t(
              'apps.controlPanel.deleteHint',
              '删除后线上站点会立刻下线；应用数据库会保留。代码不会被删除，但删除后你将无法从 TeamClu 访问它；需要找回请联系管理员。',
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 rounded-[7px] border-destructive/30 text-destructive text-[12px]"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('apps.delete', 'Delete')}
          </Button>
        </SectionCard>
      </div>

      <AlertDialog
        open={moveOpen}
        onOpenChange={(open) => {
          if (!moving) setMoveOpen(open)
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('apps.controlPanel.moveDirectory', '移动目录')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'apps.controlPanel.moveDirectoryHint',
                '将整棵应用目录（含 .git 与 node_modules）迁移到新路径。失败时会保留原目录。',
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <p className="font-mono text-[11px] text-faint break-all">{localWorkdir}</p>
            <div className="flex gap-1.5">
              <Input
                value={moveDest}
                onChange={(e) => setMoveDest(e.target.value)}
                placeholder={t('apps.controlPanel.moveDirectoryDest', '新目录路径')}
                className="h-8 flex-1 rounded-[7px] font-mono text-[12px]"
                disabled={moving}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 shrink-0 rounded-[7px] text-[12px]"
                disabled={moving}
                onClick={() => void handleMovePickFolder()}
              >
                {t('apps.controlPanel.moveDirectoryBrowse', '浏览…')}
              </Button>
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={moving}>
              {t('common.cancel', 'Cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={moving || !moveDest.trim()}
              onClick={() => void handleMoveConfirm()}
            >
              {moving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                t('apps.controlPanel.moveDirectoryConfirm', '移动')
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('apps.controlPanel.deleteTitle', '删除应用？')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'apps.controlPanel.deleteConfirm',
                '线上站点会立刻下线，应用数据库会保留。代码不会被删除，但删除后你将无法从 TeamClu 访问它；需要找回请联系管理员。',
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {t('common.cancel', 'Cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={() => void handleDelete()}
            >
              {deleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                t('apps.delete', 'Delete')
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
