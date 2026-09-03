import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Plug, RefreshCw, Loader2, Pencil, Trash2, Download, X, Share2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { ToggleSwitch } from '@/components/settings/shared'
import { useTeamShareBrowserStore, type TeamMcpItem } from '@/stores/team-share-browser'
import { findLiteralSecretKeys, type TeamMcpServerWrite } from '@/lib/backend/cloud-api/team-mcp'
import { CloudApiError } from '@/lib/backend/cloud-api/http'
import { resolveAgentDevicePresenceSync } from '@/lib/agent/agent-device-reachability'
import { useActorPresenceStore } from '@/stores/actor-presence-store'

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4 border-b border-border/60 py-2.5 last:border-b-0">
      <span className="w-28 shrink-0 text-[12.5px] text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words text-[13px] text-foreground">{children}</span>
    </div>
  )
}

function StatusBadge({ item }: { item: TeamMcpItem }) {
  const { t } = useTranslation()
  // Disabled beats every probe state: the daemon does not spawn a disabled
  // server, so whatever the last probe said is history, not status.
  if (item.installed && item.config.enabled === false) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[11.5px] font-medium text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-current" />
        {t('teamShare.mcpDetail.disabled', 'Disabled')}
      </span>
    )
  }
  // An uninstalled server has nothing to probe — saying "Idle" would imply it is
  // wired up and merely quiet, which is the opposite of the truth.
  if (!item.installed) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[11.5px] font-medium text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-current" />
        {t('teamShare.mcpDetail.notInstalled', 'Not installed')}
      </span>
    )
  }
  const map = {
    ready: { label: t('teamShare.mcpDetail.connected', 'Connected'), cls: 'bg-emerald-500/10 text-emerald-600' },
    failed: { label: t('teamShare.mcpDetail.failed', 'Needs attention'), cls: 'bg-amber-500/10 text-amber-600' },
    unknown: { label: t('teamShare.mcpDetail.idle', 'Idle'), cls: 'bg-muted text-muted-foreground' },
    skipped: { label: t('teamShare.mcpDetail.idle', 'Idle'), cls: 'bg-muted text-muted-foreground' },
  } as const
  const s = map[item.probeStatus]
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11.5px] font-medium', s.cls)}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {s.label}
    </span>
  )
}

const inputCls =
  'w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-[12.5px] text-foreground outline-none focus:border-coral'

/** `KEY=value` lines ⇄ a string map — the shape people actually paste. */
function mapToLines(map: Record<string, string> | null | undefined): string {
  if (!map) return ''
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

function linesToMap(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return out
}

export function McpEditForm({
  initial,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  initial?: TeamMcpItem
  submitLabel: string
  onCancel: () => void
  onSubmit: (input: TeamMcpServerWrite) => Promise<void>
}) {
  const { t } = useTranslation()
  // Catalog row when the server came from the team; otherwise fall back to the
  // daemon's workspace config so personal and built-in entries are editable too.
  const cat = initial?.catalog
  const cfg = initial?.config
  const cfgCommand = (cfg?.command ?? []).filter(Boolean)
  const [name, setName] = React.useState(cat?.name ?? initial?.name ?? '')
  const [transport, setTransport] = React.useState<'local' | 'remote'>(
    cat?.transport ?? (cfg?.type === 'remote' ? 'remote' : 'local'),
  )
  const [command, setCommand] = React.useState(cat?.command ?? cfgCommand[0] ?? '')
  const [args, setArgs] = React.useState((cat?.args ?? cfgCommand.slice(1)).join(' '))
  const [url, setUrl] = React.useState(cat?.url ?? cfg?.url ?? '')
  const [envText, setEnvText] = React.useState(mapToLines(cat?.env ?? cfg?.environment))
  const [headersText, setHeadersText] = React.useState(mapToLines(cat?.headers ?? cfg?.headers))
  const [description, setDescription] = React.useState(cat?.description ?? '')
  const [busy, setBusy] = React.useState(false)

  const env = React.useMemo(() => linesToMap(envText), [envText])
  const headers = React.useMemo(() => linesToMap(headersText), [headersText])
  // Mirrors the server's 422 so the user learns before saving, not after.
  const badEnvKeys = React.useMemo(() => findLiteralSecretKeys(env), [env])
  const badHeaderKeys = React.useMemo(() => findLiteralSecretKeys(headers), [headers])
  const blocked = badEnvKeys.length > 0 || badHeaderKeys.length > 0

  const submit = React.useCallback(async () => {
    if (busy || blocked) return
    setBusy(true)
    try {
      await onSubmit({
        ...(initial ? {} : { name: name.trim() }),
        transport,
        command: transport === 'local' ? command.trim() : null,
        args: transport === 'local' ? args.split(/\s+/).filter(Boolean) : null,
        url: transport === 'remote' ? url.trim() : null,
        headers: transport === 'remote' ? headers : null,
        env,
        description: description.trim() || null,
      })
    } catch (e) {
      toast.error(
        t('teamShare.mcpDetail.saveFailed', 'Save failed: {{msg}}', {
          msg: e instanceof Error ? e.message : String(e),
        }),
      )
    } finally {
      setBusy(false)
    }
  }, [busy, blocked, onSubmit, initial, name, transport, command, args, url, headers, env, description, t])

  return (
    <div className="space-y-4">
      {!initial && (
        <div>
          <label className="mb-1 block text-[12px] font-medium uppercase tracking-wide text-faint">
            {t('teamShare.mcpDetail.name', 'Name')}
          </label>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="sentry" />
        </div>
      )}

      <div>
        <label className="mb-1 block text-[12px] font-medium uppercase tracking-wide text-faint">
          {t('teamShare.mcpDetail.transport', 'Transport')}
        </label>
        <div className="flex gap-2">
          {(['local', 'remote'] as const).map((tp) => (
            <button
              key={tp}
              type="button"
              onClick={() => setTransport(tp)}
              className={cn(
                'rounded-md border px-3 py-1.5 text-[13px]',
                transport === tp ? 'border-coral bg-coral/10 text-coral' : 'border-border text-muted-foreground',
              )}
            >
              {tp === 'local' ? 'stdio' : 'http'}
            </button>
          ))}
        </div>
      </div>

      {transport === 'local' ? (
        <>
          <div>
            <label className="mb-1 block text-[12px] font-medium uppercase tracking-wide text-faint">
              {t('teamShare.mcpDetail.command', 'Command')}
            </label>
            <input className={inputCls} value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium uppercase tracking-wide text-faint">
              {t('teamShare.mcpDetail.args', 'Args')}
            </label>
            <input className={inputCls} value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y sentry-mcp" />
          </div>
        </>
      ) : (
        <>
          <div>
            <label className="mb-1 block text-[12px] font-medium uppercase tracking-wide text-faint">
              {t('teamShare.mcpDetail.endpoint', 'Endpoint')}
            </label>
            <input className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/mcp" />
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium uppercase tracking-wide text-faint">
              {t('teamShare.mcpDetail.headers', 'Headers')}
            </label>
            <textarea
              className={cn(inputCls, 'min-h-[64px]')}
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
              placeholder={'X-Api-Key=${TEAM_API_KEY}'}
            />
            {badHeaderKeys.length > 0 && <SecretWarning keys={badHeaderKeys} />}
          </div>
        </>
      )}

      <div>
        <label className="mb-1 block text-[12px] font-medium uppercase tracking-wide text-faint">
          {t('teamShare.mcpDetail.env', 'Env')}
        </label>
        <textarea
          className={cn(inputCls, 'min-h-[64px]')}
          value={envText}
          onChange={(e) => setEnvText(e.target.value)}
          placeholder={'SENTRY_AUTH_TOKEN=${TEAM_SENTRY_TOKEN}'}
        />
        {badEnvKeys.length > 0 ? (
          <SecretWarning keys={badEnvKeys} />
        ) : (
          <p className="mt-1.5 text-[12px] text-muted-foreground">
            {t(
              'teamShare.mcpDetail.envHint',
              'Secrets must reference team env as ${KEY} — the value is resolved on each member’s machine.',
            )}
          </p>
        )}
      </div>

      <div>
        <label className="mb-1 block text-[12px] font-medium uppercase tracking-wide text-faint">
          {t('teamShare.mcpDetail.description', 'Description')}
        </label>
        <input
          className={cn(inputCls, 'font-sans')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Button
          type="button"
          onClick={() => void submit()}
          disabled={busy || blocked}
          className="h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {submitLabel}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} className="h-8 text-[13px]">
          {t('common.cancel', 'Cancel')}
        </Button>
      </div>
    </div>
  )
}

function SecretWarning({ keys }: { keys: string[] }) {
  const { t } = useTranslation()
  return (
    <p className="mt-1.5 text-[12px] text-amber-600">
      {t(
        'teamShare.mcpDetail.literalSecret',
        '{{keys}} looks like a secret. Use ${KEY} so the value stays in encrypted team env instead of the shared catalog.',
        { keys: keys.join(', ') },
      )}
    </p>
  )
}

export function McpDetail({ name }: { name: string }) {
  const { t } = useTranslation()
  const item = useTeamShareBrowserStore((s) => s.mcp.items.find((x) => x.id === name))
  const loadMcpTools = useTeamShareBrowserStore((s) => s.loadMcpTools)
  const installMcp = useTeamShareBrowserStore((s) => s.installMcp)
  const uninstallMcp = useTeamShareBrowserStore((s) => s.uninstallMcp)
  const updateMcp = useTeamShareBrowserStore((s) => s.updateMcp)
  const updateWorkspaceMcp = useTeamShareBrowserStore((s) => s.updateWorkspaceMcp)
  const toggleMcp = useTeamShareBrowserStore((s) => s.toggleMcp)
  const deleteMcp = useTeamShareBrowserStore((s) => s.deleteMcp)
  const sharePersonalMcp = useTeamShareBrowserStore((s) => s.sharePersonalMcp)
  const [refreshing, setRefreshing] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [editing, setEditing] = React.useState(false)
  const [shareOpen, setShareOpen] = React.useState(false)
  const [shareDescription, setShareDescription] = React.useState('')
  const subjectActorId = useTeamShareBrowserStore((s) => s.subjectActorId)
  useActorPresenceStore((s) =>
    subjectActorId ? s.byActorId[subjectActorId]?.online : undefined,
  )
  const agentOffline = subjectActorId
    ? resolveAgentDevicePresenceSync(subjectActorId) === 'offline'
    : true

  const handleRefresh = React.useCallback(async () => {
    setRefreshing(true)
    try {
      await loadMcpTools({ refresh: true })
    } finally {
      setRefreshing(false)
    }
  }, [loadMcpTools])

  const run = React.useCallback(
    async (fn: () => Promise<void>, okMsg: string, failMsg: string) => {
      if (busy) return
      setBusy(true)
      try {
        await fn()
        toast.success(okMsg)
      } catch (e) {
        toast.error(`${failMsg}: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setBusy(false)
      }
    },
    [busy],
  )

  const runShare = React.useCallback(async () => {
    if (busy || !item) return
    setBusy(true)
    try {
      await sharePersonalMcp(item.id, {
        description: shareDescription.trim() || null,
      })
      setShareOpen(false)
      toast.success(t('teamShare.mcpShareSuccess', 'Shared and installed for you'))
    } catch (e) {
      const msg =
        e instanceof CloudApiError && (e.status === 409 || e.code === 'conflict')
          ? t('teamShare.mcpShareNameTaken', 'The team already has an MCP server called {{name}}.', {
              name: item.name,
            })
          : e instanceof Error
            ? e.message
            : String(e)
      toast.error(t('teamShare.mcpShareFailed', 'Share failed: {{msg}}', { msg }))
    } finally {
      setBusy(false)
    }
  }, [busy, item, shareDescription, sharePersonalMcp, t])

  if (!item) return null
  const cfg = item.config
  const transport = cfg.type === 'remote' ? 'http' : cfg.type === 'local' ? 'stdio' : (cfg.type ?? '—')
  const envKeys = Object.keys(cfg.environment ?? {})
  const headerKeys = Object.keys(cfg.headers ?? {})
  const isPersonal = item.kind === 'personal'
  const isBuiltin = item.kind === 'builtin'
  const isAvailable = item.kind === 'team-available'
  /** Team-catalog rows edit the catalog; personal/built-in edit the daemon map. */
  const editsCatalog = item.catalog !== null && !isPersonal && !isBuiltin
  const editable = editsCatalog || isPersonal || isBuiltin
  const canToggle = isPersonal || isBuiltin
  const enabled = item.config.enabled !== false
  const scopeLabel =
    item.kind === 'builtin'
      ? t('teamShare.mcpGroupBuiltin', 'Built-in')
      : item.kind === 'personal'
        ? t('teamShare.mcpGroupPersonal', 'Personal')
        : item.kind === 'team-available'
          ? t('teamShare.mcpGroupAvailable', 'Team · Available')
          : t('teamShare.mcpGroupInstalled', 'Team · Installed')
  const secretKeys = findLiteralSecretKeys(cfg.environment)

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3" data-tauri-drag-region>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Plug className="h-[17px] w-[17px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-faint">
            {t('teamShare.mcpDetail.server', 'MCP Server')}
          </div>
          <div className="flex items-center gap-2">
            <span className="truncate text-[15px] font-bold text-foreground">{item.name}</span>
            <StatusBadge item={item} />
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {scopeLabel}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {isAvailable && (
            <Button
              type="button"
              disabled={busy || agentOffline}
              onClick={() =>
                void run(
                  () => installMcp(item.name),
                  t('teamShare.mcpDetail.installed', 'Installed'),
                  t('teamShare.mcpDetail.installFailed', 'Install failed'),
                )
              }
              className="h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              {t('teamShare.mcpDetail.install', 'Install')}
            </Button>
          )}

          {(item.kind === 'team-installed' || isPersonal) && (
            <Button
              type="button"
              variant="outline"
              disabled={busy || agentOffline || isPersonal}
              onClick={() =>
                void run(
                  () => uninstallMcp(item.id),
                  t('teamShare.mcpDetail.uninstalled', 'Uninstalled'),
                  t('teamShare.mcpDetail.uninstallFailed', 'Uninstall failed'),
                )
              }
              className="h-8 gap-1.5 text-[13px]"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
              {t('teamShare.mcpDetail.uninstall', 'Uninstall')}
            </Button>
          )}

          {isPersonal && (
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                setShareDescription('')
                setShareOpen(true)
              }}
              className="h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90"
            >
              <Share2 className="h-3.5 w-3.5" />
              {t('teamShare.mcpShare', 'Share')}
            </Button>
          )}

          {editable && !editing && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditing(true)}
              className="h-8 gap-1.5 text-[13px]"
            >
              <Pencil className="h-3.5 w-3.5" />
              {t('teamShare.edit', 'Edit')}
            </Button>
          )}
          {editsCatalog && !editing && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(
                  () => deleteMcp(item.name),
                  t('teamShare.mcpDetail.deleted', 'Removed from the team catalog'),
                  t('teamShare.mcpDetail.deleteFailed', 'Delete failed'),
                )
              }
              className="h-8 gap-1.5 text-[13px] text-red-600 hover:text-red-700"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}

          {canToggle && (
            <div
              className="ml-1 flex items-center"
              title={
                enabled
                  ? t('teamShare.mcpDetail.disableHint', 'Disable — the daemon stops offering this server')
                  : t('teamShare.mcpDetail.enableHint', 'Enable this server for this workspace')
              }
            >
              <ToggleSwitch
                enabled={enabled}
                onChange={(next) =>
                  void run(
                    () => toggleMcp(item.id, next),
                    next
                      ? t('teamShare.mcpDetail.enabled', 'Enabled')
                      : t('teamShare.mcpDetail.disabledToast', 'Disabled'),
                    t('teamShare.mcpDetail.toggleFailed', 'Toggle failed'),
                  )
                }
              />
            </div>
          )}

          {!isAvailable && (
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleRefresh()}
              disabled={refreshing}
              className="h-8 gap-1.5 text-[13px]"
            >
              {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {t('teamShare.mcpDetail.resync', 'Re-sync')}
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-6 px-6 py-5">
        {editing && editable ? (
          <McpEditForm
            initial={item}
            submitLabel={t('teamShare.mcpDetail.save', 'Save')}
            onCancel={() => setEditing(false)}
            onSubmit={async (input) => {
              if (editsCatalog) await updateMcp(item.name, input)
              else await updateWorkspaceMcp(item.id, input)
              setEditing(false)
              toast.success(t('teamShare.mcpDetail.saved', 'Saved'))
            }}
          />
        ) : (
          <>
            {isAvailable && (
              <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-[13px] text-muted-foreground">
                {t(
                  'teamShare.mcpDetail.notInstalledHint',
                  'Available to the team but not running for you. Installing starts this server on your machine.',
                )}
              </div>
            )}
            {isPersonal && (
              <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-[13px] text-muted-foreground">
                {t(
                  'teamShare.mcpDetail.personalHint',
                  'This server only runs on this machine. It is not in the team catalog. Uninstall removes it locally; Share publishes it to the team and installs it for you.',
                )}
              </div>
            )}
            {isBuiltin && (
              <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-[13px] text-muted-foreground">
                {t(
                  'teamShare.mcpDetail.builtinHint',
                  'Ships with the app and cannot be removed. You can disable it for this workspace, or edit how it starts.',
                )}
              </div>
            )}

            {item.catalog?.description && (
              <p className="text-[14px] leading-relaxed text-foreground">{item.catalog.description}</p>
            )}

            <section>
              <h3 className="mb-1 text-[12px] font-medium uppercase tracking-wide text-faint">
                {t('teamShare.mcpDetail.connection', 'Connection')}
              </h3>
              <InfoRow label={t('teamShare.mcpDetail.transport', 'Transport')}>{transport}</InfoRow>
              {cfg.url && (
                <InfoRow label={t('teamShare.mcpDetail.endpoint', 'Endpoint')}>
                  <span className="font-mono text-[12.5px]">{cfg.url}</span>
                </InfoRow>
              )}
              {cfg.command && cfg.command.length > 0 && (
                <InfoRow label={t('teamShare.mcpDetail.command', 'Command')}>
                  <span className="font-mono text-[12.5px]">{cfg.command.join(' ')}</span>
                </InfoRow>
              )}
              <InfoRow label={t('teamShare.mcpDetail.scope', 'Scope')}>{scopeLabel}</InfoRow>
              {envKeys.length > 0 && (
                <InfoRow label={t('teamShare.mcpDetail.env', 'Env')}>
                  <span className="font-mono text-[12.5px]">{envKeys.join(', ')}</span>
                </InfoRow>
              )}
              {headerKeys.length > 0 && (
                <InfoRow label={t('teamShare.mcpDetail.headers', 'Headers')}>
                  <span className="font-mono text-[12.5px]">{headerKeys.join(', ')}</span>
                </InfoRow>
              )}
            </section>

            {item.installed && (
              <section>
                <h3 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-faint">
                  {t('teamShare.mcpDetail.tools', 'Tools')} · {item.tools.length}
                </h3>
                {item.probeStatus === 'unknown' ? (
                  <p className="text-[13px] text-muted-foreground">
                    {t('teamShare.mcpDetail.probeHint', 'Re-sync to load tools.')}
                  </p>
                ) : item.error ? (
                  <p className="text-[13px] text-amber-600">{item.error}</p>
                ) : item.tools.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">
                    {t('teamShare.mcpDetail.noTools', 'No tools reported.')}
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {item.tools.map((tool) => (
                      <div
                        key={tool}
                        className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2"
                      >
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                        <span className="font-mono text-[12.5px] font-semibold text-foreground">{tool}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>

      <Dialog open={shareOpen} onOpenChange={(open) => !busy && setShareOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('teamShare.mcpShareTitle', 'Share to team')}</DialogTitle>
            <DialogDescription>
              {t(
                'teamShare.mcpShareHint',
                'Publishes this server to the team catalog and installs it for you. Local-only copies are removed afterwards.',
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-[12.5px] text-muted-foreground">
                {t('teamShare.mcpDetail.name', 'Name')}
              </label>
              <div className="font-mono text-[13px] text-foreground">{item.name}</div>
            </div>
            <div>
              <label className="mb-1 block text-[12.5px] text-muted-foreground">
                {t('teamShare.mcpDetail.description', 'Description')}
              </label>
              <textarea
                value={shareDescription}
                onChange={(e) => setShareDescription(e.target.value)}
                rows={3}
                className={inputCls}
              />
            </div>
            {secretKeys.length > 0 && <SecretWarning keys={secretKeys} />}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setShareOpen(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              disabled={busy}
              onClick={() => void runShare()}
              className="bg-coral text-white hover:bg-coral/90"
            >
              {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              {t('teamShare.mcpShareSubmit', 'Share & install')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
