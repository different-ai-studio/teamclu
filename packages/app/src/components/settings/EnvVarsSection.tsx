import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { KeyRound, Plus, Eye, EyeOff, Pencil, Trash2, ShieldCheck, AlertCircle, Users, User, Lock, Copy, Check, TriangleAlert } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SettingCard, SectionHeader } from './shared'
import { useEnvVarsStore } from '@/stores/env-vars'
import { useTeamMembersStore } from '@/stores/team-members'
import { useTeamPermissions } from '@/lib/team/team-permissions'
import { encodeWorkspaceId, notifyDaemonRuntimePendingChanges } from '@/lib/daemon/daemon-local-client'
import { formatEnvKeyActivationStatus } from '@/lib/diagnostics/env-diagnostics'
import { useWorkspaceStore } from '@/stores/workspace'
import { useCurrentTeamStore } from '@/stores/current-team'
import { toast } from 'sonner'
import { listen } from '@tauri-apps/api/event'
import { useShallow } from 'zustand/react/shallow'

// ─── Unified type for the combined list ─────────────────────────────────

type UnifiedEntry =
  | { scope: 'personal'; key: string; description?: string; category?: 'system' | 'system-shared' | null; dirty?: boolean }
  | { scope: 'team'; key: string; description: string; category: string; createdBy: string; updatedBy: string; updatedAt: string; dirty?: boolean; notDecrypted?: boolean; keyMismatch?: boolean }
  // Placeholder shown when a `system-shared` system def exists but the team secret
  // has not yet been set. Edit-saves default to "Share with team".
  | { scope: 'team-placeholder'; key: string; description?: string; category: 'system-shared'; dirty?: boolean }

// ─── Add / Edit Dialog ──────────────────────────────────────────────────

/** True when a save failed because the local team secret is missing/wrong, so
 *  a shared write cannot be encrypted or synced. Matched on the stable backend
 *  error text from `try_lazy_init_from_workspace`. */
function isTeamSecretMissingError(message: string): boolean {
  return (
    message.includes('not initialized') ||
    message.includes('Missing team encryption key') ||
    message.includes('No team configured') ||
    message.includes('derived_key not set')
  )
}

interface EnvVarDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingEntry?: UnifiedEntry | null
  /** Local team secret is missing/wrong — shared writes won't sync. */
  teamSecretMissing?: boolean
  onSave: (key: string, value: string, description: string, shared: boolean) => Promise<void>
}

function EnvVarDialog({ open, onOpenChange, editingEntry, teamSecretMissing, onSave }: EnvVarDialogProps) {
  const { t } = useTranslation()
  const { role } = useTeamPermissions()
  const teamAvailable = role !== null
  const [key, setKey] = React.useState('')
  const [value, setValue] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [shared, setShared] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [showValue, setShowValue] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const isEditing = !!editingEntry
  // `system-shared` placeholders haven't been saved yet; treat the dialog as a
  // first-time create so a value is required and the key+description are seeded
  // from the system definition.
  const isPlaceholder = editingEntry?.scope === 'team-placeholder'
  const isFirstSave = !isEditing || isPlaceholder
  // Lock the key for system / system-shared / placeholder rows so the user can't
  // rename a system-managed entry into something else.
  const lockedKey =
    isPlaceholder ||
    (editingEntry?.scope === 'personal' && editingEntry.category === 'system') ||
    editingEntry?.scope === 'team'

  React.useEffect(() => {
    if (open) {
      setShowValue(false)
      if (editingEntry) {
        setKey(editingEntry.key)
        setDescription(editingEntry.description || '')
        // Default-share when editing a team secret OR a system-shared placeholder,
        // but only if a team is actually available.
        setShared(
          teamAvailable &&
            (editingEntry.scope === 'team' || editingEntry.scope === 'team-placeholder'),
        )
        setValue('')
      } else {
        setKey('')
        setValue('')
        setDescription('')
        setShared(false)
      }
      setError(null)
    }
  }, [open, editingEntry, teamAvailable])

  const handleSave = async () => {
    const trimmedKey = key.trim()
    if (!trimmedKey) {
      setError(t('settings.envVars.error.keyRequired', 'Key is required'))
      return
    }
    if (!value && isFirstSave) {
      setError(t('settings.envVars.error.valueRequired', 'Value is required'))
      return
    }
    if (!value && isEditing && !isPlaceholder) {
      setError(t('settings.envVars.error.valueRequired', 'Please enter the new value'))
      return
    }
    // shared team keys must be lowercase server-side. For system-shared
    // placeholder rows the displayed key is uppercase (matches the env-var name
    // autoui-mcp reads), but the dialog stores the lowercase form transparently
    // — so we accept either case here and let `onSave` normalize.
    if (shared) {
      const probe = isPlaceholder ? trimmedKey.toLowerCase() : trimmedKey
      if (!/^[a-z0-9_]+$/.test(probe) || probe.length > 64) {
        setError(t('settings.envVars.error.invalidKeyShared', 'Shared key must be lowercase letters, digits, underscores (max 64 chars)'))
        return
      }
    } else {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmedKey)) {
        setError(t('settings.envVars.error.invalidKey', 'Key must contain only letters, digits, and underscores'))
        return
      }
    }

    setSaving(true)
    setError(null)
    try {
      // Lowercase the key when saving a system-shared placeholder as a team
      // secret — the displayed name is uppercase (env-var convention) but
      // Team keys are stored lowercase; the agent injects both cases at startup.
      const outboundKey = isPlaceholder && shared ? trimmedKey.toLowerCase() : trimmedKey
      await onSave(outboundKey, value, description.trim() || '', shared)
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEditing
              ? t('settings.envVars.editTitle', 'Edit Environment Variable')
              : t('settings.envVars.addTitle', 'Add Environment Variable')}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? t('settings.envVars.editDescription', 'Update the value for this environment variable.')
              : t('settings.envVars.addDescription', 'Add a new secret that will be stored securely.')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <label className="text-[13px] font-medium">
              {t('settings.envVars.key', 'Key')}
            </label>
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={shared ? 'openai_api_key' : 'MY_API_KEY'}
              disabled={lockedKey}
              autoFocus={!lockedKey}
            />
          </div>

          <div className="space-y-2">
            <label className="text-[13px] font-medium">
              {t('settings.envVars.value', 'Value')}
            </label>
            <div className="relative">
              <Input
                type={showValue ? 'text' : 'password'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={isEditing ? '••••••••' : 'sk-...'}
                autoFocus={isEditing}
                className="pr-9"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={() => setShowValue((v) => !v)}
                tabIndex={-1}
                title={showValue ? t('settings.envVars.hideValue', 'Hide value') : t('settings.envVars.showValue', 'Show value')}
              >
                {showValue ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-[13px] font-medium">
              {t('settings.envVars.description', 'Description')}
              <span className="text-muted-foreground font-normal ml-1">
                ({t('settings.envVars.optional', 'optional')})
              </span>
            </label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('settings.envVars.descriptionPlaceholder', 'e.g. OpenAI API key for production')}
            />
          </div>

          {/* Share with team checkbox — locked for system-shared placeholders
              (always team-shared) and existing team secrets (scope is fixed).
              Hidden entirely when the user has not joined a team. */}
          {teamAvailable && (
            <>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="shared"
                  checked={shared}
                  onCheckedChange={(checked) => setShared(checked === true)}
                  disabled={isEditing || isPlaceholder}
                />
                <label htmlFor="shared" className="text-[13px] font-medium cursor-pointer select-none flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5 text-blue-500" />
                  {t('settings.envVars.shareWithTeam', 'Share with team')}
                </label>
              </div>
              {shared && isFirstSave && (
                <p className="text-xs text-muted-foreground ml-6">
                  {t('settings.envVars.shareHint', 'This variable will be encrypted and synced to all team members.')}
                </p>
              )}
            </>
          )}

          {/* Local team secret missing/wrong → shared writes can't be encrypted
              or synced. Show a yellow warning (before and after a failed save)
              rather than an opaque red error. */}
          {shared && (teamSecretMissing || (error && isTeamSecretMissingError(error))) && (
            <div className="flex items-start gap-2 rounded-[10px] border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <span>
                {t('settings.envVars.localSecretMissingWrite', '本地密钥缺失，未同步：本机缺少团队密钥，此变量无法加密并同步给团队。请先在设置 → Daemon → 通用中填写正确的团队加密密钥。')}
              </span>
            </div>
          )}

          {error && !isTeamSecretMissingError(error) && (
            <p className="text-[13px] text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving
              ? t('common.saving', 'Saving...')
              : t('common.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Delete Confirmation Dialog ─────────────────────────────────────────

interface DeleteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  envVarKey: string
  onConfirm: () => Promise<void>
}

function DeleteDialog({ open, onOpenChange, envVarKey, onConfirm }: DeleteDialogProps) {
  const { t } = useTranslation()
  const [deleting, setDeleting] = React.useState(false)

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch (err) {
      toast.error(t('settings.envVars.deleteFailed', 'Failed to delete environment variable'), {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settings.envVars.deleteTitle', 'Delete Environment Variable')}</DialogTitle>
          <DialogDescription>
            {t('settings.envVars.deleteDescription', 'Are you sure you want to delete "{{key}}"? This will remove the secret and cannot be undone.', { key: envVarKey })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleting}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? t('common.deleting', 'Deleting...') : t('common.delete', 'Delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Env Var Row ────────────────────────────────────────────────────────

interface EnvVarRowProps {
  entry: UnifiedEntry
  canDelete: boolean
  injectionStatus?: string | null
  onEdit: (entry: UnifiedEntry) => void
  onDelete: (key: string) => void
}

function EnvVarRow({ entry, canDelete, injectionStatus, onEdit, onDelete }: EnvVarRowProps) {
  const { t } = useTranslation()
  const [revealed, setRevealed] = React.useState(false)
  const [revealedValue, setRevealedValue] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const { getEnvVarValue } = useEnvVarsStore(
    useShallow((s) => ({ getEnvVarValue: s.getEnvVarValue })),
  )

  const isSystem = entry.scope === 'personal' && entry.category === 'system'
  const isSystemShared = entry.category === 'system-shared'
  const isPersonal = entry.scope === 'personal'
  const isPlaceholder = entry.scope === 'team-placeholder'

  const handleReveal = async () => {
    if (!isPersonal) return // Team secrets / placeholders cannot be revealed
    if (revealed) {
      setRevealed(false)
      setRevealedValue(null)
      return
    }
    setLoading(true)
    try {
      const value = await getEnvVarValue(entry.key)
      setRevealedValue(value)
      setRevealed(true)
      setTimeout(() => {
        setRevealed(false)
        setRevealedValue(null)
      }, 5000)
    } catch {
      setRevealedValue(null)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex items-center justify-between py-3 px-1 group">
      <div className="flex-1 min-w-0 mr-4">
        <div className="flex items-center gap-2">
          <code className="text-[13px] font-mono font-medium bg-muted px-2 py-0.5 rounded">
            {entry.key}
          </code>
          {isSystemShared ? (
            // System-managed key whose value is team-shared: show both badges so
            // the user knows it's auto-registered AND syncs across the team.
            <>
              <span className="inline-flex items-center gap-1 text-xs text-violet-600 dark:text-violet-400 bg-violet-50 dark:bg-violet-950/40 px-1.5 py-0.5 rounded">
                <Lock className="h-3 w-3" />
                {t('settings.envVars.scopeSystem', 'System')}
              </span>
              <span className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 px-1.5 py-0.5 rounded">
                <Users className="h-3 w-3" />
                {t('settings.envVars.scopeTeam', 'Team')}
              </span>
            </>
          ) : isSystem ? (
            <span className="inline-flex items-center gap-1 text-xs text-violet-600 dark:text-violet-400 bg-violet-50 dark:bg-violet-950/40 px-1.5 py-0.5 rounded">
              <Lock className="h-3 w-3" />
              {t('settings.envVars.scopeSystem', 'System')}
            </span>
          ) : isPersonal ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              <User className="h-3 w-3" />
              {t('settings.envVars.scopePersonal', 'Personal')}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 px-1.5 py-0.5 rounded">
              <Users className="h-3 w-3" />
              {t('settings.envVars.scopeTeam', 'Team')}
            </span>
          )}
          {isPlaceholder && (
            <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 px-1.5 py-0.5 rounded">
              <AlertCircle className="h-3 w-3" />
              {t('settings.envVars.notConfigured', 'Not configured')}
            </span>
          )}
          {entry.scope === 'team' && entry.notDecrypted && (
            <span
              className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 px-1.5 py-0.5 rounded"
              title={entry.keyMismatch
                ? t('settings.envVars.keyMismatchHint', '此变量是用另一个（已轮换/更早的）团队密钥加密的，本机当前密钥解不开。需由持有明文的成员重新保存该变量。')
                : t('settings.envVars.notDecryptedHint', '本机缺少团队密钥，无法解密此变量。请在设置 → Daemon → 通用中填写正确的团队加密密钥。')}
            >
              <TriangleAlert className="h-3 w-3" />
              {entry.keyMismatch
                ? t('settings.envVars.keyMismatch', '密钥不匹配')
                : t('settings.envVars.localKeyMissing', '本地密钥缺失')}
            </span>
          )}
          {entry.dirty && (
            <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 px-1.5 py-0.5 rounded">
              <AlertCircle className="h-3 w-3" />
              {t('settings.envVars.needRestart', 'Need restart')}
            </span>
          )}
          {injectionStatus && (
            <span
              className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded ${
                injectionStatus === 'active'
                  ? 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40'
                  : injectionStatus === 'overridden' || injectionStatus === 'host_shadowed' || injectionStatus === 'not_served'
                    ? 'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40'
                    : 'text-muted-foreground bg-muted'
              }`}
              title={formatEnvKeyActivationStatus(t, injectionStatus) ?? injectionStatus}
            >
              {formatEnvKeyActivationStatus(t, injectionStatus)}
            </span>
          )}
        </div>
        {entry.description && (
          <p className="text-xs text-muted-foreground mt-1 truncate">
            {entry.description}
          </p>
        )}
        {isPersonal && revealed && revealedValue !== null && (
          <div className="flex items-center gap-1 mt-1">
            <p className="text-xs font-mono text-muted-foreground bg-muted/50 px-2 py-1 rounded break-all flex-1 min-w-0">
              {revealedValue}
            </p>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              onClick={async () => {
                await navigator.clipboard.writeText(revealedValue)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
              title={t('common.copy', 'Copy')}
            >
              {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
            </Button>
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {isPersonal && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleReveal}
            disabled={loading}
            title={revealed
              ? t('settings.envVars.hide', 'Hide value')
              : t('settings.envVars.reveal', 'Reveal value')}
          >
            {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => onEdit(entry)}
          title={t('settings.envVars.edit', 'Edit')}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        {canDelete && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive hover:text-destructive"
            onClick={() => onDelete(entry.key)}
            title={t('settings.envVars.delete', 'Delete')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  )
}

// ─── Team sync diagnostics ──────────────────────────────────────────────

interface TeamEnvDiagnostics {
  teamIdPresent: boolean
  teamLinkPath: string
  linkExists: boolean
  linkIsSymlink: boolean
  linkTarget: string | null
  targetAccessible: boolean
  /** Daemon cloud cache `~/.amuxd/teams/<id>/cloud/_secrets`. */
  secretsDirExists: boolean
  secretFileCount: number
  cloudSecretsDir?: string
  legacySecretsDirExists?: boolean
  legacySecretFileCount?: number
  secretConfigured: boolean
}

/** One diagnostic row: green check when ok, amber warning when not. */
function DiagRow({ ok, label, value, hint }: { ok: boolean; label: string; value?: string; hint?: string }) {
  return (
    <div className="flex items-start gap-2 py-1">
      {ok ? (
        <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
      ) : (
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[13px] font-medium text-foreground">{label}</span>
          {value && (
            <span className="text-xs font-mono text-muted-foreground break-all">{value}</span>
          )}
        </div>
        {hint && <p className="text-xs text-amber-700 dark:text-amber-300 mt-0.5">{hint}</p>}
      </div>
    </div>
  )
}

function TeamEnvDiagnosticsCard({
  teamId,
  teamName,
  workspacePath,
  refreshKey,
}: {
  teamId: string | null
  teamName: string | null
  workspacePath: string | null
  refreshKey: number
}) {
  const { t } = useTranslation()
  const [diag, setDiag] = React.useState<TeamEnvDiagnostics | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!workspacePath) return
    let cancelled = false
    void invoke<TeamEnvDiagnostics>('team_env_diagnostics', { teamId, workspacePath })
      .then((d) => { if (!cancelled) { setDiag(d); setError(null) } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [teamId, workspacePath, refreshKey])

  const linkOk = !!diag && diag.linkExists && diag.targetAccessible
  const linkHint = diag
    ? !diag.linkExists
      ? t('settings.envVars.diag.linkMissing', '工作区未链接团队目录（软链不存在）。请在 Team Shared 设置中开通/加入团队共享。')
      : !diag.targetAccessible
        ? t('settings.envVars.diag.linkDangling', '软链存在但指向的目标无法访问（悬空链接）。团队目录可能已被删除或移动。')
        : undefined
    : undefined

  return (
    <SettingCard>
      <div className="flex items-start gap-3">
        <AlertCircle className="h-5 w-5 text-blue-500 mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1 text-[13px]">
          <p className="font-medium text-foreground mb-2">
            {t('settings.envVars.diag.title', '团队同步诊断')}
          </p>

          {error ? (
            <p className="text-destructive">{error}</p>
          ) : !diag ? (
            <p className="text-muted-foreground">{t('common.loading', 'Loading...')}</p>
          ) : (
            <div className="divide-y divide-border/60">
              {/* 1. Team */}
              <DiagRow
                ok={diag.teamIdPresent}
                label={t('settings.envVars.diag.team', '当前团队')}
                value={teamName ?? (teamId ?? undefined)}
                hint={
                  !diag.teamIdPresent
                    ? t('settings.envVars.diag.teamMissing', '当前未加入团队或 team id 缺失，团队变量无法同步。')
                    : undefined
                }
              />
              {/* 2. Workspace team symlink */}
              <DiagRow
                ok={linkOk}
                label={t('settings.envVars.diag.link', '团队目录软链')}
                value={diag.linkTarget ? `${diag.teamLinkPath} → ${diag.linkTarget}` : diag.teamLinkPath}
                hint={linkHint}
              />
              {/* 3. Team secret */}
              <DiagRow
                ok={diag.secretConfigured}
                label={t('settings.envVars.diag.secret', '团队密钥')}
                value={diag.secretConfigured
                  ? t('settings.envVars.diag.secretOk', '已配置')
                  : t('settings.envVars.diag.secretMissingShort', '未配置')}
                hint={
                  !diag.secretConfigured
                    ? t('settings.envVars.diag.secretMissing', '本机没有团队密钥，无法加密/解密团队变量。请在设置 → Daemon → 通用中填写正确的团队加密密钥。')
                    : undefined
                }
              />
              {/* Encrypted files in daemon cloud cache */}
              <DiagRow
                ok={diag.secretsDirExists}
                label={t('settings.envVars.diag.files', '云端缓存')}
                value={t(
                  'settings.envVars.diag.filesCount',
                  '{{count}} 个 (cloud/_secrets/*.enc.json)',
                  { count: diag.secretFileCount },
                )}
                hint={
                  !diag.secretsDirExists
                    ? t(
                        'settings.envVars.diag.filesMissing',
                        'daemon 尚未拉取团队 env 云缓存（写完后应立即 reconcile；否则最长约 5 分钟）。若团队还没有人设置过变量，首次写入后也会创建该目录。',
                      )
                    : undefined
                }
              />

              {/* Other possible causes */}
              <div className="pt-2 mt-1">
                <p className="text-xs font-medium text-foreground mb-1">
                  {t('settings.envVars.diag.otherTitle', '其他可能的异常原因')}
                </p>
                <ul className="list-disc pl-4 text-xs text-muted-foreground space-y-0.5">
                  <li>{t('settings.envVars.diag.other1', 'daemon 未运行，或写完后未能触发 cloud-config reconcile，缓存尚未更新。')}</li>
                  <li>{t('settings.envVars.diag.other2', '本机团队密钥与加密时用的密钥不一致（成员看到「未解密」标记）。')}</li>
                  <li>{t('settings.envVars.diag.other3', '团队变量只在新建 Agent 会话时注入，改动后需要重启会话才生效。')}</li>
                  <li>{t('settings.envVars.diag.other4', '变量名不合法（团队变量仅支持小写字母、数字、下划线，最长 64 字符）。')}</li>
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    </SettingCard>
  )
}

// ─── Main Section ───────────────────────────────────────────────────────

export const EnvVarsSection = React.memo(function EnvVarsSection() {
  const { t } = useTranslation()
  const { envVars, teamSecrets, isLoading: envLoading, loadEnvCatalog, setCatalogEntry, deleteCatalogEntry } = useEnvVarsStore(
    useShallow((s) => ({ envVars: s.envVars, teamSecrets: s.teamSecrets, isLoading: s.isLoading, loadEnvCatalog: s.loadEnvCatalog, setCatalogEntry: s.setCatalogEntry, deleteCatalogEntry: s.deleteCatalogEntry })),
  )
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const teamName = useCurrentTeamStore((s) => s.team?.name ?? null)
  const currentNodeId = useTeamMembersStore((s) => s.currentNodeId)
  // currentNodeId is hydrated here (and via useAppInit) since the Team panel no longer owns it.
  const loadCurrentNodeId = useTeamMembersStore((s) => s.loadCurrentNodeId)
  const { isOwner } = useTeamPermissions()

  const [addDialogOpen, setAddDialogOpen] = React.useState(false)
  const [editingEntry, setEditingEntry] = React.useState<UnifiedEntry | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<UnifiedEntry | null>(null)
  const [dirtyKeys, setDirtyKeys] = React.useState<Set<string>>(new Set())
  const [teamEnvAvailable, setTeamEnvAvailable] = React.useState<boolean | null>(null)
  const [diagRefreshKey, setDiagRefreshKey] = React.useState(0)

  const resolveInjectionStatus = React.useCallback((entry: UnifiedEntry): string | null => {
    if (entry.scope === 'team-placeholder') return 'missing'
    return null
  }, [])

  const isLoading = envLoading

  React.useEffect(() => {
    // No workspace gate: personal env is home-scoped and team env is cloud —
    // the catalog loads either way (see `currentWorkspacePath` in the store).
    void (async () => {
      await loadEnvCatalog()
      const err = useEnvVarsStore.getState().error
      if (err) {
        toast.error(t('settings.envVars.loadFailed', 'Failed to load environment variables'), {
          description: err,
        })
      }
    })()

    loadCurrentNodeId()
    let unlistenSync: (() => void) | undefined
    listen<void>('secrets-changed', () => {
      void (async () => {
        await loadEnvCatalog()
        const err = useEnvVarsStore.getState().error
        if (err) {
          toast.error(t('settings.envVars.loadFailed', 'Failed to load environment variables'), {
            description: err,
          })
        }
      })()
      setDirtyKeys((prev) => {
        const next = new Set(prev)
        next.add('__team_sync__')
        return next
      })
    }).then((fn) => { unlistenSync = fn })
    return () => {
      unlistenSync?.()
    }
  }, [loadEnvCatalog, loadCurrentNodeId, workspacePath, t])

  // Files under teamclu-team/_secrets may exist while this daemon lacks the
  // team key needed to decrypt them. Ask the daemon rather than inferring from
  // the file list; the response deliberately contains no secret material.
  React.useEffect(() => {
    let cancelled = false
    if (!teamId) {
      setTeamEnvAvailable(null)
      return
    }
    setTeamEnvAvailable(null)
    void invoke<boolean>('team_env_runtime_status', { teamId, workspacePath })
      .then((available) => {
        if (!cancelled) setTeamEnvAvailable(available)
      })
      .catch(() => {
        // A stopped daemon is indeterminate, not evidence that the team key is
        // absent. Avoid a false red warning while the local service restarts.
        if (!cancelled) setTeamEnvAvailable(null)
      })
    return () => { cancelled = true }
  }, [teamId, workspacePath])

  // Build unified list: personal env vars + team secrets, with `system-shared`
  // system defs surfaced as either the matching team secret (uppercase key) or
  // a placeholder row when no value has been set yet.
  const hasSyncDirty = dirtyKeys.has('__team_sync__')
  const unifiedEntries: UnifiedEntry[] = React.useMemo(() => {
    const sharedSystemDefs = envVars.filter((e) => e.category === 'system-shared')
    // lowercase(secretKey) -> matching system-shared def (so we can promote the
    // team secret's display key to the canonical uppercase name)
    const sharedSystemByLower = new Map(
      sharedSystemDefs.map((d) => [d.key.toLowerCase(), d] as const),
    )
    // Track which lowercase secret keys have been satisfied so we can suppress
    // the placeholder when a value already exists.
    const satisfiedLowerKeys = new Set<string>()

    const team: UnifiedEntry[] = teamSecrets.map((s) => {
      const lower = s.keyId.toLowerCase()
      const matched = sharedSystemByLower.get(lower)
      if (matched) {
        satisfiedLowerKeys.add(lower)
      }
      return {
        scope: 'team' as const,
        key: matched ? matched.key : s.keyId,
        description: matched?.description || s.description,
        category: matched ? 'system-shared' : s.category,
        createdBy: s.createdBy,
        updatedBy: s.updatedBy,
        updatedAt: s.updatedAt,
        dirty: dirtyKeys.has(s.keyId) || hasSyncDirty,
        notDecrypted: s.decrypted === false,
        keyMismatch: s.keyMismatch === true,
      }
    })

    const personalByKey = new Map<string, UnifiedEntry>()
    for (const entry of envVars.filter((e) => e.category !== 'system-shared')) {
      const lower = entry.key.toLowerCase()
      if (personalByKey.has(lower)) continue
      personalByKey.set(lower, {
        scope: 'personal' as const,
        key: entry.key,
        description: entry.description,
        category: entry.category,
        dirty: dirtyKeys.has(entry.key) || [...dirtyKeys].some((k) => k.toLowerCase() === lower),
      })
    }
    const personal: UnifiedEntry[] = [...personalByKey.values()]

    const placeholders: UnifiedEntry[] = sharedSystemDefs
      .filter((d) => !satisfiedLowerKeys.has(d.key.toLowerCase()))
      .map((d) => ({
        scope: 'team-placeholder' as const,
        key: d.key,
        description: d.description,
        category: 'system-shared' as const,
        dirty: dirtyKeys.has(d.key),
      }))

    const all = [...team, ...placeholders, ...personal]
    // System entries (locally seeded) first, then everything else alphabetical.
    all.sort((a, b) => {
      const aIsSystem = a.scope === 'personal' && a.category === 'system'
      const bIsSystem = b.scope === 'personal' && b.category === 'system'
      if (aIsSystem && !bIsSystem) return -1
      if (!aIsSystem && bIsSystem) return 1
      return a.key.localeCompare(b.key)
    })
    return all
  }, [envVars, teamSecrets, dirtyKeys, hasSyncDirty])

  async function queueEnvRuntimeRefresh(key: string): Promise<boolean> {
    const path = useWorkspaceStore.getState().workspacePath
    if (!path) {
      toast.warning(
        t('settings.envVars.savedNoWorkspace', '环境变量已保存，但无法通知运行时'),
        { description: t('settings.envVars.noWorkspace', '未选择工作区。') },
      )
      return false
    }
    try {
      const ok = await notifyDaemonRuntimePendingChanges(encodeWorkspaceId(path), ['env_vars'])
      if (!ok) {
        toast.warning(
          t('settings.envVars.savedNotifyFailed', '环境变量已保存，但未能排队自动重载'),
          {
            description: t(
              'settings.envVars.notifyDaemonUnavailable',
              '本地 amuxd 不可用。运行时下次检测到环境漂移时会补录该变更，或可在设置 → Daemon → 通用中强制重载。',
            ),
          },
        )
        return false
      }
      setDirtyKeys((prev) => {
        const next = new Set(prev)
        next.delete(key)
        next.delete('__team_sync__')
        return next
      })
      setDiagRefreshKey((k) => k + 1)
      toast.success(t('settings.envVars.savedQueued', '环境变量已保存'), {
        description: t(
          'settings.envVars.savedQueuedHint',
          '空闲后将自动生效；急需时可在设置 → Daemon → 通用中强制重载。',
        ),
      })
      return true
    } catch (err) {
      toast.warning(
        t('settings.envVars.savedNotifyFailed', '环境变量已保存，但未能排队自动重载'),
        { description: err instanceof Error ? err.message : String(err) },
      )
      return false
    }
  }

  const handleSave = async (key: string, value: string, description: string, shared: boolean) => {
    if (shared) {
      await setCatalogEntry('team', key, value, {
        description,
        category: 'custom',
        nodeId: currentNodeId ?? '',
      })
    } else {
      await setCatalogEntry('personal', key, value, { description: description || undefined })
    }
    await queueEnvRuntimeRefresh(key)
  }

  async function handleDelete() {
    if (!deleteTarget) return
    const deletedKey = deleteTarget.key
    try {
      if (deleteTarget.scope === 'team') {
        await deleteCatalogEntry('team', deleteTarget.key, {
          nodeId: currentNodeId ?? '',
          role: isOwner ? 'owner' : 'member',
        })
      } else if (deleteTarget.scope === 'personal') {
        await deleteCatalogEntry('personal', deleteTarget.key)
      }
      setDeleteTarget(null)
      await queueEnvRuntimeRefresh(deletedKey)
      toast.success(t('settings.envVars.deleteSuccess', 'Environment variable deleted'))
    } catch (err) {
      toast.error(t('settings.envVars.deleteFailed', 'Failed to delete environment variable'), {
        description: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  // env_catalog_delete enforces the system-var guard server-side for personal scope.
  const canDeleteEntry = (entry: UnifiedEntry): boolean => {
    if (entry.scope === 'team-placeholder') return false
    if (entry.scope === 'personal' && (entry.category === 'system' || entry.category === 'system-shared')) return false
    if (entry.scope === 'personal') return true
    if (entry.scope === 'team' && entry.category === 'system-shared') return false
    if (isOwner) return true
    if (entry.scope === 'team' && entry.createdBy === currentNodeId) return true
    return false
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={KeyRound}
        title={t('settings.envVars.title', 'Environment Variables')}
        description={t('settings.envVars.sectionDescription', 'Securely store API keys, passwords, and other secrets in your system keychain')}
        iconColor="text-emerald-500"
      />

      {teamEnvAvailable === false && (
        <div className="flex items-start gap-3 rounded-[14px] border border-amber-300/70 bg-amber-50 px-4 py-3 text-[13px] text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div>
            <p className="font-semibold">
              {t('settings.envVars.teamUnavailableTitle', 'Team variables are not available to this agent')}
            </p>
            <p className="mt-0.5 text-amber-800 dark:text-amber-200">
              {t('settings.envVars.teamUnavailableBody', '本机 daemon 没有解密团队变量所需的团队密钥。请在设置 → Daemon → 通用中填写正确的团队加密密钥，然后新建一个 Agent 会话。')}
            </p>
          </div>
        </div>
      )}

      {/* Action bar */}
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-muted-foreground">
          {unifiedEntries.length > 0
            ? t('settings.envVars.count', '{{count}} variable(s) stored', { count: unifiedEntries.length })
            : ''}
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setAddDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-1" />
            {t('settings.envVars.add', 'Add Variable')}
          </Button>
        </div>
      </div>

      {/* List or empty state */}
      {isLoading && unifiedEntries.length === 0 ? (
        <SettingCard>
          <div className="flex items-center justify-center py-8 text-muted-foreground text-[13px]">
            {t('common.loading', 'Loading...')}
          </div>
        </SettingCard>
      ) : unifiedEntries.length === 0 ? (
        <SettingCard className="bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30 border-emerald-200 dark:border-emerald-800">
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <ShieldCheck className="h-10 w-10 text-emerald-500 mb-3" />
            <h4 className="font-medium mb-1">
              {t('settings.envVars.emptyTitle', 'No environment variables yet')}
            </h4>
            <p className="text-[13px] text-muted-foreground max-w-sm">
              {t('settings.envVars.emptyDescription', 'Store your API keys and passwords securely. Values are encrypted using your system keychain (macOS Keychain / Windows Credential Manager).')}
            </p>
            <Button size="sm" className="mt-4" onClick={() => setAddDialogOpen(true)}>
              <Plus className="h-4 w-4 mr-1" />
              {t('settings.envVars.addFirst', 'Add Your First Variable')}
            </Button>
          </div>
        </SettingCard>
      ) : (
        <SettingCard>
          <div className="divide-y">
            {unifiedEntries.map((entry) => (
              <EnvVarRow
                key={`${entry.scope}-${entry.key}`}
                entry={entry}
                canDelete={canDeleteEntry(entry)}
                injectionStatus={resolveInjectionStatus(entry)}
                onEdit={(e) => setEditingEntry(e)}
                onDelete={() => setDeleteTarget(entry)}
              />
            ))}
          </div>
        </SettingCard>
      )}

      <TeamEnvDiagnosticsCard
        teamId={teamId}
        teamName={teamName}
        workspacePath={workspacePath ?? null}
        refreshKey={dirtyKeys.size + diagRefreshKey}
      />

      {/* Dialogs */}
      <EnvVarDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        teamSecretMissing={teamEnvAvailable === false}
        onSave={handleSave}
      />

      <EnvVarDialog
        open={!!editingEntry}
        onOpenChange={(open) => { if (!open) setEditingEntry(null) }}
        editingEntry={editingEntry}
        teamSecretMissing={teamEnvAvailable === false}
        onSave={handleSave}
      />

      <DeleteDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        envVarKey={deleteTarget?.key || ''}
        onConfirm={handleDelete}
      />
    </div>
  )
})
