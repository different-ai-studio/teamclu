import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Box, ChevronDown, Loader2 } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ModelPickerCommand } from '@/components/model/ModelPickerCommand'
import { SectionHeader, SettingCard } from '../shared'
import { cn } from '@/lib/utils'
import { loadGatewayModel, saveGatewayModel } from '@/lib/daemon/amuxd-channels'
import {
  loadDeviceModelOptions,
  type DeviceModelOption,
  type DeviceModelsReason,
} from '@/lib/agent/device-default-models'
import { getDaemonLocalAgent } from '@/lib/daemon/daemon-local-client'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useCronStore } from '@/stores/cron'
import { clientMruModels } from '@/stores/client-model-mru'
import { useAutomationDefaultModelStore } from '@/stores/automation-default-model'
import { useUIStore } from '@/stores/ui'

/**
 * Every "which model" answer on this device, in one card.
 *
 * # Why they are shown together but not merged
 *
 * The three surfaces do not share a mechanism, and pretending they do is how
 * you get the bugs each one was built to avoid:
 *
 *  - **Gateway** — a real run-time default (`channels.model`, team-scoped). It
 *    has to be: an inbound WeCom message creates a session with no form to
 *    pre-fill and nobody watching.
 *  - **Cron** — pinned per job at creation (ADR-0007). The default here is a
 *    *pre-fill for the create form only*; changing it never moves an existing
 *    job, which is the property that stopped "same job, different model on
 *    every device".
 *  - **Chat** — already answered by `client-model-mru` + `agent-model-pick-
 *    store`, whose contract warns that a second writer is what produces the
 *    "selected model keeps reverting" bug. So chat is displayed here and driven
 *    from nowhere here.
 *
 * # Why the failure reason is on the card, not inside the popover
 *
 * It used to live in the picker's empty state, which meant a user who could not
 * choose a model saw a normal-looking dropdown that did nothing — the reason was
 * one click away and the control gave no sign it was dead. An empty catalog now
 * disables both triggers and says why in the open, with a retry. Same for a pick
 * that cannot be stored: without a backend or a team, `setDefault` is a silent
 * no-op, which is indistinguishable from a broken menu, so that trigger is
 * disabled too rather than accepting a click and dropping it.
 */
export function AgentModelDefaults() {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const openSettings = useUIStore((s) => s.openSettings)
  const cronJobs = useCronStore((s) => s.jobs)
  const loadCronJobs = useCronStore((s) => s.loadJobs)
  const defaultsByBackendTeam = useAutomationDefaultModelStore((s) => s.byBackendTeam)
  const setDefault = useAutomationDefaultModelStore((s) => s.setDefault)

  const [options, setOptions] = React.useState<DeviceModelOption[]>([])
  const [reason, setReason] = React.useState<DeviceModelsReason>('ok')
  const [loading, setLoading] = React.useState(true)
  const [reloadTick, setReloadTick] = React.useState(0)
  const [backend, setBackend] = React.useState<string>('')
  const [gatewayModel, setGatewayModel] = React.useState<string | null>(null)
  const [gatewayOpen, setGatewayOpen] = React.useState(false)
  const [cronOpen, setCronOpen] = React.useState(false)
  const [savingGateway, setSavingGateway] = React.useState(false)

  // Both pickers live inside the Settings dialog, which is a MODAL Radix
  // dialog: it puts `pointer-events: none` on <body> and scopes interaction to
  // its own content subtree. A popover portalled to `document.body` (the
  // default) lands outside that subtree, so it never becomes usable — the
  // trigger looks normal and clicking it does nothing. `popover.tsx` documents
  // this and `CronJobDialog` already works around it the same way: portal into
  // a node inside the dialog. Resolved from our own DOM position rather than a
  // global query so it stays correct if this card is ever mounted elsewhere
  // (outside a dialog it resolves to undefined, which is the normal default).
  const cardRef = React.useRef<HTMLDivElement>(null)
  const [portalHost, setPortalHost] = React.useState<HTMLElement | undefined>(undefined)
  React.useEffect(() => {
    const host = cardRef.current?.closest('[data-slot=dialog-content]')
    setPortalHost(host instanceof HTMLElement ? host : undefined)
  }, [])

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      const result = await loadDeviceModelOptions(teamId).catch(() => null)
      if (cancelled) return
      if (!result) {
        setReason('failed')
        setLoading(false)
        return
      }
      setOptions(result.options)
      setReason(result.reason)
      // The catalog names its own default backend; fall back to the configured
      // local agent so the store key is stable even when the catalog is empty.
      const fromCatalog = result.defaultBackend ?? result.options[0]?.backend ?? ''
      if (fromCatalog) {
        setBackend(fromCatalog)
      } else {
        const agent = await getDaemonLocalAgent().catch(() => null)
        if (!cancelled && agent) setBackend(agent)
      }
      if (!cancelled) setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [teamId, reloadTick])

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const current = await loadGatewayModel()
        if (!cancelled) setGatewayModel(current)
      } catch {
        // Daemon down — the row still renders, it just cannot say what is set.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reloadTick])

  // The cron row is a read-only summary; the section that owns the list may not
  // have been opened yet, so ask for it rather than assume it is loaded.
  React.useEffect(() => {
    void loadCronJobs().catch(() => {})
  }, [loadCronJobs])

  const pickerModels = React.useMemo(
    () =>
      options.map((o) => ({
        id: o.id,
        displayName: o.displayName,
        providerName: o.providerName,
      })),
    [options],
  )

  const problem = React.useMemo(() => {
    if (loading || options.length > 0) return null
    switch (reason) {
      case 'no-default-workspace':
        return t(
          'settings.modelDefaults.noDefaultWorkspace',
          'Set a default workspace in Daemon settings first.',
        )
      case 'daemon-unavailable':
        return t('settings.modelDefaults.daemonUnavailable', 'Daemon is not ready yet.')
      case 'no-models':
        return t(
          'settings.modelDefaults.noModels',
          'No models available. Configure a provider first.',
        )
      default:
        return t('settings.modelDefaults.loadFailed', 'Failed to load models.')
    }
  }, [loading, options.length, reason, t])

  const canPickGateway = !problem
  const canPickCron = !problem && !!backend && !!teamId

  // Read through the store map (not the imperative helper) so the row re-renders
  // when the pick changes; the helper exists for callers that cannot use hooks.
  const cronDefault =
    backend && teamId ? (defaultsByBackendTeam[`${backend}::${teamId}`] ?? '') : ''

  const chatNext = React.useMemo(() => clientMruModels(backend, teamId)[0] ?? '', [backend, teamId])

  const distinctCronModels = React.useMemo(
    () => new Set(cronJobs.map((j) => j.payload.model?.trim()).filter(Boolean)).size,
    [cronJobs],
  )

  const applyGateway = async (next: string) => {
    setGatewayOpen(false)
    setSavingGateway(true)
    // Optimistic: the daemon write is one-way (no reply on the sock), so there
    // is no ack to wait for. A failed save surfaces on the next mount.
    setGatewayModel(next || null)
    try {
      await saveGatewayModel(next)
    } catch (error) {
      console.error('[AgentModelDefaults] gateway save failed', error)
    } finally {
      setSavingGateway(false)
    }
  }

  const pickerFor = (selectedId: string, onSelect: (id: string) => void) => (
    <ModelPickerCommand models={pickerModels} selectedId={selectedId} onSelect={onSelect} />
  )

  const trigger = (label: string | null, unsetLabel: string, enabled: boolean) => (
    <button
      type="button"
      disabled={!enabled}
      className={cn(
        'flex h-7 w-fit max-w-[16rem] items-center gap-1.5 rounded-md border border-border/70 px-2 font-mono text-[11.5px]',
        'hover:bg-muted/60 focus:outline-none data-[state=open]:bg-muted/60',
        !label && 'italic font-sans text-muted-foreground',
        !enabled && 'cursor-not-allowed opacity-50 hover:bg-transparent',
      )}
    >
      <span className="truncate">{label || unsetLabel}</span>
      <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
    </button>
  )

  /** One entry point: name, a one-line "when does this apply", and its control. */
  const row = (title: string, note: React.ReactNode, control: React.ReactNode) => (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <p className="text-[13px] font-medium">{title}</p>
        <p className="mt-0.5 text-[12px] text-muted-foreground">{note}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">{control}</div>
    </div>
  )

  return (
    <div className="mb-8" ref={cardRef}>
      <SectionHeader
        icon={Box}
        title={t('settings.modelDefaults.title', 'Model defaults')}
        description={t(
          'settings.modelDefaults.description',
          'Where the gateway, scheduled jobs and chat each get their model from.',
        )}
      />

      <SettingCard>
        {problem && (
          <div className="mb-1 flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-2 text-[12px] text-muted-foreground">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{problem}</span>
            <button
              type="button"
              className="shrink-0 underline-offset-2 hover:underline"
              onClick={() => setReloadTick((n) => n + 1)}
            >
              {t('settings.modelDefaults.retry', 'Retry')}
            </button>
          </div>
        )}

        <div className="divide-y divide-border-soft">
          {row(
            t('settings.modelDefaults.gateway', 'Gateway'),
            t(
              'settings.modelDefaults.gatewayShort',
              'Applies immediately to new sessions on every channel',
            ),
            <>
              {savingGateway && (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              )}
              <Popover open={gatewayOpen} onOpenChange={setGatewayOpen}>
                <PopoverTrigger asChild>
                  {trigger(
                    gatewayModel,
                    t('settings.modelDefaults.gatewayUnset', 'Let the backend choose'),
                    canPickGateway,
                  )}
                </PopoverTrigger>
                <PopoverContent container={portalHost} align="end" sideOffset={6} className="w-[20rem] p-0">
                  {pickerFor(gatewayModel ?? '', (id) => void applyGateway(id))}
                </PopoverContent>
              </Popover>
              {/* Without this there is no way back to unpinned once a model is
                  picked — `saveGatewayModel('')` is the documented clear and had
                  no affordance, so the setting was one-way in the UI. */}
              {gatewayModel && (
                <button
                  type="button"
                  className="text-[12px] text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => void applyGateway('')}
                >
                  {t('settings.modelDefaults.clear', 'Clear')}
                </button>
              )}
            </>,
          )}

          {row(
            t('settings.modelDefaults.cron', 'Scheduled jobs'),
            <>
              {t(
                'settings.modelDefaults.cronShort',
                'Pre-fills new jobs only; existing jobs keep theirs',
              )}
              {cronJobs.length > 0 && (
                <>
                  {' · '}
                  <button
                    type="button"
                    className="underline-offset-2 hover:underline"
                    onClick={() => openSettings('automation')}
                  >
                    {t('settings.modelDefaults.cronJobs', {
                      // Not `count`: i18next reads that as a plural selector and
                      // goes looking for `_one` / `_other` variants we do not define.
                      jobs: cronJobs.length,
                      distinct: distinctCronModels,
                      defaultValue: '{{jobs}} existing · {{distinct}} model(s)',
                    })}
                  </button>
                </>
              )}
            </>,
            <>
              <Popover open={cronOpen} onOpenChange={setCronOpen}>
                <PopoverTrigger asChild>
                  {trigger(cronDefault, t('settings.modelDefaults.cronUnset', 'Not set'), canPickCron)}
                </PopoverTrigger>
                <PopoverContent container={portalHost} align="end" sideOffset={6} className="w-[20rem] p-0">
                  {pickerFor(cronDefault, (id) => {
                    setCronOpen(false)
                    if (backend && teamId) setDefault(backend, teamId, id)
                  })}
                </PopoverContent>
              </Popover>
              {cronDefault && (
                <button
                  type="button"
                  className="text-[12px] text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => backend && teamId && setDefault(backend, teamId, '')}
                >
                  {t('settings.modelDefaults.clear', 'Clear')}
                </button>
              )}
            </>,
          )}

          {row(
            t('settings.modelDefaults.chat', 'Chat'),
            chatNext
              ? t('settings.modelDefaults.chatShort', 'Follows your last pick in chat')
              : t('settings.modelDefaults.chatNone', 'Nothing picked yet — the first send will ask'),
            <span className="font-mono text-[11.5px] text-muted-foreground">{chatNext || '—'}</span>,
          )}
        </div>
      </SettingCard>
    </div>
  )
}
