import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Box, Pencil, Trash2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useEnvVarsStore } from '@/stores/env-vars'
import { useTeamMembersStore } from '@/stores/team-members'
import { useTeamShareBrowserStore } from '@/stores/team-share-browser'

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4 border-b border-border/60 py-2.5 last:border-b-0">
      <span className="w-28 shrink-0 text-[12.5px] text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words text-[13px] text-foreground">{children}</span>
    </div>
  )
}

const inputCls =
  'w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] text-foreground outline-none focus:border-coral'

/** Same rule as the desktop `validate_key_id` and the server's column check. */
const KEY_ID_RE = /^[a-z0-9_]{1,64}$/
/**
 * A personal key becomes a real environment variable name on the agent's spawn
 * command, so it has to be a legal one. Nothing downstream checks: the Rust
 * personal path validates nothing, and a name with a space or `=` is silently
 * dropped or corrupts the surrounding block. The settings dialog this form
 * replaced enforced exactly this.
 */
const PERSONAL_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Match SharedSecretsState init failures — keep keywords aligned with EnvVarsSection. */
function isTeamSecretMissingError(message: string): boolean {
  return (
    message.includes('not initialized') ||
    message.includes('Missing team encryption key') ||
    message.includes('No team configured') ||
    message.includes('derived_key not set')
  )
}

function toastSaveError(
  t: (key: string, fallback: string, options?: Record<string, string>) => string,
  err: unknown,
) {
  const msg = err instanceof Error ? err.message : String(err)
  if (isTeamSecretMissingError(msg)) {
    toast.error(
      t(
        'teamShare.envDetail.secretMissing',
        '本机缺少团队加密密钥，无法保存。请先在设置 → Daemon → 通用中配置。',
      ),
    )
    return
  }
  toast.error(
    t('teamShare.envDetail.saveFailed', 'Save failed: {{msg}}', { msg }),
  )
}

/**
 * Add a new team env key. Lives here rather than in the list column so the
 * create and edit forms stay adjacent — they share the "value is write-only,
 * encrypted before it leaves the machine" contract, and that is easy to break
 * from a distance.
 */
/**
 * Resolve the local daemon actor id, which team-scope writes are attributed to.
 *
 * The store only ever had `reset()` called on it — the one component that used
 * to load it was the old Settings > Env Variables page, and that navigation
 * entry is gone. So `currentNodeId` stayed null, every team write sent
 * `nodeId: ''`, and the Rust command refused it ("nodeId is required for team
 * env vars"). Loading it where it is consumed keeps that from drifting apart
 * again. The store call is idempotent and returns early once resolved.
 */
function useCurrentNodeId(): string | null {
  const currentNodeId = useTeamMembersStore((s) => s.currentNodeId)
  const loadCurrentNodeId = useTeamMembersStore((s) => s.loadCurrentNodeId)
  React.useEffect(() => {
    if (!currentNodeId) void loadCurrentNodeId()
  }, [currentNodeId, loadCurrentNodeId])
  return currentNodeId
}

export function EnvCreateForm({
  onDone,
  onCancel,
  onScopeChange,
}: {
  onDone: () => void
  onCancel: () => void
  /** Lets the surrounding pane retitle itself — the header lives outside this form. */
  onScopeChange?: (scope: 'team' | 'personal') => void
}) {
  const { t } = useTranslation()
  const setCatalogEntry = useEnvVarsStore((s) => s.setCatalogEntry)
  // Team-scope writes are node-attributed; the Rust command rejects the call
  // outright without it (env_vars.rs: "nodeId is required for team env vars").
  const currentNodeId = useCurrentNodeId()
  const [scope, setScope] = React.useState<'team' | 'personal'>('team')
  const [keyId, setKeyId] = React.useState('')
  const [value, setValue] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [category, setCategory] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  // The key-id charset is a team-store rule (it becomes a row key server-side).
  // Personal keys are ordinary env var names and conventionally upper-case, so
  // holding them to the team rule would reject `OPENAI_API_KEY`.
  const keyValid =
    scope === 'team' ? KEY_ID_RE.test(keyId) : PERSONAL_KEY_RE.test(keyId.trim())
  // Team writes need the local daemon actor. Say so, rather than greying the
  // button out for a reason that is nowhere on screen.
  const teamBlocker =
    scope === 'team' && !currentNodeId
      ? t('teamShare.envDetail.needsDaemon', 'Waiting for the local daemon — team keys are attributed to it.')
      : keyId.length > 0 && !keyValid
        ? scope === 'team'
          ? t('teamShare.envDetail.keyIdRule', 'Team keys allow lower-case letters, digits and underscore only.')
          : t(
              'teamShare.envDetail.personalKeyRule',
              'Must be a valid environment variable name: letters, digits and underscore, not starting with a digit.',
            )
        : null
  const canSubmit = keyValid && value.trim().length > 0 && !busy && !teamBlocker

  const submit = React.useCallback(async () => {
    if (!canSubmit) return
    setBusy(true)
    try {
      await setCatalogEntry(scope, keyId.trim(), value, {
        description: description.trim() || undefined,
        category: category.trim() || 'custom',
        ...(scope === 'team' ? { nodeId: currentNodeId ?? '' } : {}),
      })
      toast.success(t('teamShare.envDetail.added', 'Added'))
      onDone()
    } catch (e) {
      toastSaveError(t, e)
    } finally {
      setBusy(false)
    }
  }, [canSubmit, setCatalogEntry, scope, keyId, value, description, category, currentNodeId, t, onDone])

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 block text-[12px] font-medium uppercase tracking-wide text-faint">
          {t('teamShare.scope.label', 'Scope')}
        </label>
        <div className="flex gap-2">
          {(['team', 'personal'] as const).map((s2) => (
            <button
              key={s2}
              type="button"
              onClick={() => {
                setScope(s2)
                onScopeChange?.(s2)
              }}
              className={cn(
                'rounded-md border px-3 py-1.5 text-[13px]',
                scope === s2 ? 'border-coral bg-coral/10 text-coral' : 'border-border text-muted-foreground',
              )}
            >
              {s2 === 'team' ? t('teamShare.scope.team', 'Team') : t('teamShare.scope.personal', 'Personal')}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[12px] text-muted-foreground">
          {scope === 'team'
            ? t(
                'teamShare.envDetail.teamScopeHint',
                'Encrypted with the team key and shared with every member.',
              )
            : t(
                'teamShare.envDetail.personalScopeHint',
                'Stays on this machine. Never uploaded.',
              )}
        </p>
      </div>
      <div>
        <label className="mb-1 block text-[12px] font-medium uppercase tracking-wide text-faint">
          {t('teamShare.envDetail.key', 'Key')}
        </label>
        <input
          className={cn(inputCls, 'font-mono text-[12.5px]')}
          value={keyId}
          autoFocus
          onChange={(e) => setKeyId(e.target.value)}
          placeholder="team_api_token"
        />
        {keyId && !keyValid && scope === 'team' && (
          <p className="mt-1.5 text-[12px] text-amber-600">
            {t(
              'teamShare.envDetail.keyRule',
              'Lowercase letters, digits and underscores only, up to 64 characters.',
            )}
          </p>
        )}
      </div>
      <div>
        <label className="mb-1 block text-[12px] font-medium uppercase tracking-wide text-faint">
          {t('teamShare.envDetail.value', 'Value')}
        </label>
        <input
          className={cn(inputCls, 'font-mono text-[12.5px]')}
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <p className="mt-1.5 text-[12px] text-muted-foreground">
          {scope === 'team'
            ? t(
                'teamShare.envDetail.encryptOnSave',
                'Encrypted with the team key before it leaves this machine. The server only ever stores ciphertext.',
              )
            : t(
                'teamShare.envDetail.personalOnSave',
                'Encrypted and kept on this machine. Personal values are never uploaded.',
              )}
        </p>
      </div>
      <div>
        <label className="mb-1 block text-[12px] font-medium uppercase tracking-wide text-faint">
          {t('teamShare.envDetail.description', 'Description')}
        </label>
        <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div>
        <label className="mb-1 block text-[12px] font-medium uppercase tracking-wide text-faint">
          {t('teamShare.envDetail.category', 'Category')}
        </label>
        <input className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)} />
      </div>
      {teamBlocker && (
        <p className="text-[12px] text-amber-600">{teamBlocker}</p>
      )}
      <div className="flex items-center gap-2 pt-1">
        <Button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          className="h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {scope === 'team'
            ? t('teamShare.envAddSubmitTeam', 'Add to team')
            : t('teamShare.envAddSubmitPersonal', 'Add for me')}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} className="h-8 text-[13px]">
          {t('common.cancel', 'Cancel')}
        </Button>
      </div>
    </div>
  )
}

/** `team:FOO` / `personal:FOO` — see the list column for why the scope is in the id. */
function parseEnvSelection(id: string): { scope: 'team' | 'personal'; key: string } {
  if (id.startsWith('personal:')) return { scope: 'personal', key: id.slice('personal:'.length) }
  if (id.startsWith('team:')) return { scope: 'team', key: id.slice('team:'.length) }
  // Selections made before ids carried a scope were team-only.
  return { scope: 'team', key: id }
}

export function EnvDetail({ keyId: selectionId }: { keyId: string }) {
  const { t } = useTranslation()
  const { scope, key: keyId } = parseEnvSelection(selectionId)
  const isTeam = scope === 'team'
  const teamItem = useEnvVarsStore((s) => s.teamSecrets.find((x) => x.keyId === keyId))
  const personalItem = useEnvVarsStore((s) => s.envVars.find((x) => x.key === keyId))
  // Memoised because it is a fresh object every render for the personal branch,
  // which would otherwise invalidate every callback that closes over it.
  const item = React.useMemo(
    () =>
      isTeam
        ? teamItem
        : personalItem && {
            keyId: personalItem.key,
            description: personalItem.description ?? '',
            category: personalItem.category ?? '',
            // The personal store keeps no authorship trail; the detail rows
            // below render "—" for these rather than inventing one.
            createdBy: '',
            updatedBy: '',
            updatedAt: '',
          },
    [isTeam, teamItem, personalItem],
  )
  /** The team key on this machine will not open this value. */
  const undecryptable = isTeam && teamItem?.decrypted === false
  const setCatalogEntry = useEnvVarsStore((s) => s.setCatalogEntry)
  const deleteCatalogEntry = useEnvVarsStore((s) => s.deleteCatalogEntry)
  const currentNodeId = useCurrentNodeId()
  const select = useTeamShareBrowserStore((s) => s.select)
  const loadCounts = useTeamShareBrowserStore((s) => s.loadCounts)

  const [editing, setEditing] = React.useState(false)
  const [value, setValue] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [category, setCategory] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const beginEdit = React.useCallback(() => {
    // The value is deliberately not prefilled: it is encrypted with the team key
    // and never fetched back for display. Editing is "replace", not "amend".
    setValue('')
    setDescription(item?.description ?? '')
    setCategory(item?.category ?? '')
    setEditing(true)
  }, [item])

  const save = React.useCallback(async () => {
    if (busy || !value.trim()) return
    setBusy(true)
    try {
      await setCatalogEntry(scope, keyId, value, {
        description: description.trim() || undefined,
        category: category.trim() || 'custom',
        // Only the team scope is node-attributed; the personal store ignores it.
        ...(isTeam ? { nodeId: currentNodeId ?? '' } : {}),
      })
      setEditing(false)
      setValue('')
      toast.success(t('teamShare.envDetail.saved', 'Saved'))
    } catch (e) {
      toastSaveError(t, e)
    } finally {
      setBusy(false)
    }
  }, [busy, value, setCatalogEntry, scope, isTeam, keyId, description, category, currentNodeId, t])

  const remove = React.useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      await deleteCatalogEntry(scope, keyId, isTeam ? { nodeId: currentNodeId ?? '' } : {})
      select('env', null)
      await loadCounts()
      toast.success(t('teamShare.envDetail.deleted', 'Deleted'))
    } catch (e) {
      toast.error(
        t('teamShare.envDetail.deleteFailed', 'Delete failed: {{msg}}', {
          msg: e instanceof Error ? e.message : String(e),
        }),
      )
    } finally {
      setBusy(false)
    }
  }, [busy, deleteCatalogEntry, scope, isTeam, keyId, currentNodeId, select, loadCounts, t])

  if (!item) return null

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3" data-tauri-drag-region>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Box className="h-[17px] w-[17px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-faint">
            {isTeam
              ? t('teamShare.scope.team', 'Team')
              : t('teamShare.scope.personal', 'Personal')}
          </div>
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-[15px] font-bold text-foreground">{item.keyId}</span>
            {undecryptable && (
              <span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600">
                {t('teamShare.envDetail.locked', 'Locked')}
              </span>
            )}
          </div>
        </div>
        {!editing && (
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              onClick={beginEdit}
              className="h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90"
            >
              <Pencil className="h-3.5 w-3.5" />
              {t('teamShare.edit', 'Edit')}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void remove()}
              className="h-8 gap-1.5 text-[13px] text-red-600 hover:text-red-700"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            </Button>
          </div>
        )}
      </div>

      <div className="space-y-6 px-6 py-5">
        {editing ? (
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-[12px] font-medium uppercase tracking-wide text-faint">
                {t('teamShare.envDetail.newValue', 'New value')}
              </label>
              <input
                className={cn(inputCls, 'font-mono text-[12.5px]')}
                type="password"
                value={value}
                autoFocus
                onChange={(e) => setValue(e.target.value)}
                placeholder={t('teamShare.envDetail.valuePlaceholder', 'Enter the replacement value')}
              />
              <p className="mt-1.5 text-[12px] text-muted-foreground">
                {isTeam
                  ? t(
                      'teamShare.envDetail.encryptOnSave',
                      'Encrypted with the team key before it leaves this machine. The server only ever stores ciphertext.',
                    )
                  : t(
                      'teamShare.envDetail.personalOnSave',
                      'Encrypted and kept on this machine. Personal values are never uploaded.',
                    )}
              </p>
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-medium uppercase tracking-wide text-faint">
                {t('teamShare.envDetail.description', 'Description')}
              </label>
              <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-medium uppercase tracking-wide text-faint">
                {t('teamShare.envDetail.category', 'Category')}
              </label>
              <input className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)} />
            </div>
            <div className="flex items-center gap-2 pt-1">
              <Button
                type="button"
                onClick={() => void save()}
                disabled={busy || !value.trim()}
                className="h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90"
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {t('teamShare.envDetail.save', 'Save')}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditing(false)}
                className="h-8 text-[13px]"
              >
                {t('common.cancel', 'Cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {item.description && <p className="text-[14px] leading-relaxed text-foreground">{item.description}</p>}

            <section>
              <div className="mb-1 text-[12px] font-medium uppercase tracking-wide text-faint">
                {t('teamShare.envDetail.value', 'Value')}
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-4 py-3">
                <span className="font-mono text-[14px] tracking-widest text-muted-foreground">••••••••</span>
              </div>
              <p className="mt-1.5 text-[12px] text-muted-foreground">
                {undecryptable
                  ? teamItem?.keyMismatch
                    ? t(
                        'teamShare.envDetail.keyMismatchHint',
                        'This value exists, but the team key on this machine does not decrypt it. Save the correct team key, or replace the value with Edit.',
                      )
                    : t(
                        'teamShare.envDetail.noLocalKeyHint',
                        'This value exists, but no team key is configured on this machine. Save the team key to read it.',
                      )
                  : isTeam
                    ? t(
                        'teamShare.envDetail.encryptedHint',
                        'Team values are encrypted and not shown here. Use Edit to replace.',
                      )
                    : t(
                        'teamShare.envDetail.personalEncryptedHint',
                        'Stored encrypted on this machine and never uploaded. Use Edit to replace.',
                      )}
              </p>
            </section>

            <section>
              <h3 className="mb-1 text-[12px] font-medium uppercase tracking-wide text-faint">
                {t('teamShare.envDetail.details', 'Details')}
              </h3>
              <InfoRow label={t('teamShare.envDetail.key', 'Key')}>
                <span className="font-mono text-[12.5px]">{item.keyId}</span>
              </InfoRow>
              <InfoRow label={t('teamShare.envDetail.category', 'Category')}>
                {item.category || t('teamShare.envDetail.secret', 'Secret')}
              </InfoRow>
              <InfoRow label={t('teamShare.scope.label', 'Scope')}>
                {isTeam ? t('teamShare.scope.team', 'Team') : t('teamShare.scope.personal', 'Personal')}
              </InfoRow>
              <InfoRow label={t('teamShare.envDetail.createdBy', 'Created by')}>{item.createdBy || '—'}</InfoRow>
              <InfoRow label={t('teamShare.envDetail.updatedBy', 'Updated by')}>{item.updatedBy || '—'}</InfoRow>
              <InfoRow label={t('teamShare.envDetail.updatedAt', 'Updated at')}>{item.updatedAt || '—'}</InfoRow>
            </section>
          </>
        )}
      </div>
    </div>
  )
}
