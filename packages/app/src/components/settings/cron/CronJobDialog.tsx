/**
 * CronJobDialog - Create/Edit job dialog form.
 * Extracted from CronSection.tsx.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  Box,
  ChevronDown,
  Loader2,
  SlidersHorizontal,
  Timer,
  Send,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { invoke } from '@tauri-apps/api/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  useCronStore,
  type CronJob,
  type CreateCronJobRequest,
  type UpdateCronJobRequest,
  type ScheduleKind,
  type DeliveryChannel,
} from '@/stores/cron'
import { useChannelsStore } from '@/stores/channels'
import { useWorkspaceStore } from '@/stores/workspace'
import { useCurrentTeamStore } from '@/stores/current-team'
import { automationDefaultForBackends } from '@/stores/automation-default-model'
import { loadCronDialogModels, type CronModelGroup } from '@/lib/cron-workspace-models'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { ModelPickerCommand } from '@/components/model/ModelPickerCommand'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'
import { ToggleSwitch } from '../shared'
import {
  type JobFormState,
  defaultFormState,
  jobToFormState,
  formStateToSchedule,
  formStateToPayload,
  formStateToDelivery,
  isoToLocalDatetime,
  localDatetimeToIso,
  DELIVERY_CHANNEL_REGISTRY,
  getRegistryEntry,
} from '@/lib/cron-utils'
import { useShallow } from 'zustand/react/shallow'

/** One conversation the bot can be addressed in, as amuxd reports it. */
type WeComChat = {
  botId: string
  botName?: string | null
  chatId: string
  chatName: string
  chatType: string
  lastMsgTime: string
}

/**
 * Pick a WeCom target from the bot's own conversation list.
 *
 * The ids are otherwise unguessable — a group chatid appears nowhere in the UI,
 * so setting this up meant reading it out of the gateway log. The list comes
 * from the bot's MCP endpoint, so it only appears once an API key is configured
 * for that bot; without one this collapses to the manual fields that were the
 * only option before.
 */
function WeComChatPicker({
  selected,
  onPick,
}: {
  selected?: string
  onPick: (chat: WeComChat) => void
}) {
  const { t } = useTranslation()
  const [chats, setChats] = React.useState<WeComChat[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    invoke<{ chats?: WeComChat[]; errors?: Array<{ botId: string; error: string }> }>(
      'list_wecom_chats',
    )
      .then((res) => {
        if (cancelled) return
        setChats(res.chats ?? [])
        // A refused key is worth showing: the alternative is an empty list with
        // no reason, which reads as "this bot has no chats".
        setError(res.errors?.length ? res.errors[0]!.error : null)
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) {
    return (
      <p className="text-xs text-muted-foreground">
        {t('settings.cron.wecomChats.loading', 'Loading conversations…')}
      </p>
    )
  }
  if (!chats?.length) {
    return (
      <p className="text-xs text-muted-foreground">
        {error ||
          t(
            'settings.cron.wecomChats.empty',
            'No conversation list — add this bot\u2019s MCP API key in Channels to pick from a list.',
          )}
      </p>
    )
  }

  return (
    <div className="space-y-2">
      <label className="text-[13px] font-medium">
        {t('settings.cron.wecomChats.label', 'Conversation')}
      </label>
      <div className="max-h-40 overflow-y-auto rounded-[7px] border border-border">
        {chats.map((chat) => (
          <button
            key={`${chat.botId}:${chat.chatId}`}
            type="button"
            onClick={() => onPick(chat)}
            className={cn(
              'flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs transition-colors',
              selected === chat.chatId ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
            )}
          >
            <span className="truncate">
              {chat.chatName ||
                (chat.chatType === 'group'
                  ? t('settings.cron.wecomChats.unnamedGroup', 'Group chat')
                  : chat.chatId)}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              {chat.chatType} · {chat.lastMsgTime}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

export function CronJobDialog({
  open,
  onOpenChange,
  editJob,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  editJob?: CronJob
}) {
  const { t } = useTranslation()
  const { addJob, updateJob, runJob, activeScope, selectedWorkspacePath } = useCronStore(
    useShallow((s) => ({ addJob: s.addJob, updateJob: s.updateJob, runJob: s.runJob, activeScope: s.activeScope, selectedWorkspacePath: s.selectedWorkspacePath })),
  )
  const channelsStore = useChannelsStore()
  const daemonHttpReady = useWorkspaceStore((s) => s.daemonHttpReady)
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const runtimeModelSignature = useRuntimeStateStore((s) =>
    Object.entries(s.byRuntimeId)
      .map(([runtimeId, entry]) => {
        const models = entry.info.availableModels
          .map((model) => `${model.id}:${model.displayName}`)
          .join('|')
        return `${runtimeId}:${entry.info.worktree}:${models}`
      })
      .sort()
      .join(';'),
  )

  const [form, setForm] = React.useState<JobFormState>(defaultFormState)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [advancedOptionsOpen, setAdvancedOptionsOpen] = React.useState(false)
  const [modelGroups, setModelGroups] = React.useState<CronModelGroup[]>([])
  const [modelHint, setModelHint] = React.useState<string | null>(null)
  const [modelMenuOpen, setModelMenuOpen] = React.useState(false)
  const dialogContentRef = React.useRef<HTMLDivElement>(null)
  const advancedScrollAnchorRef = React.useRef<HTMLDivElement>(null)

  // ref → backend lookup so selecting a model pins the backend it runs on.
  const backendByRef = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const group of modelGroups) {
      for (const model of group.models) map.set(model.ref, group.backend)
    }
    return map
  }, [modelGroups])

  const modelOptions = React.useMemo(
    () => modelGroups.flatMap((group) => group.models),
    [modelGroups],
  )

  // Flat options for the shared model picker (it groups by provider internally,
  // matching the chat prompt-input picker's two-level presentation).
  const pickerModels = React.useMemo(
    () =>
      modelOptions.map((m) => ({
        id: m.ref,
        displayName: m.name,
        providerName: m.providerName,
      })),
    [modelOptions],
  )

  React.useEffect(() => {
    if (!open) return
    let cancelled = false

    ;(async () => {
      const { groups, hint } = await loadCronDialogModels({
        activeScope,
        teamId,
        selectedWorkspacePath:
          activeScope === 'workspace' ? selectedWorkspacePath : null,
        messages: {
          workspaceNoPath: t(
            'settings.cron.workspaceModelsNoPath',
            'Select a workspace first.',
          ),
          globalNoTeam: t(
            'settings.cron.globalModelsNoTeam',
            'Join a team to load daemon models.',
          ),
          globalNoDefault: t(
            'settings.cron.globalModelsNoDefault',
            'Set a default workspace in Daemon settings.',
          ),
          globalNoDefaultPath: t(
            'settings.cron.globalModelsNoDefaultPath',
            'Default workspace has no local path on this daemon.',
          ),
          daemonUnavailable: t(
            'settings.cron.modelsDaemonUnavailable',
            'Daemon HTTP is not ready. Wait for the app to finish starting, then try again.',
          ),
          noConfiguredModels: t(
            'settings.cron.modelsNoConfigured',
            'No configured models for this workspace. Add a provider in LLM settings, or use global cron with the daemon default workspace.',
          ),
          loadFailed: t('settings.cron.modelsLoadFailed', 'Failed to load models.'),
        },
      })
      if (cancelled) return
      setModelGroups(groups)
      setModelHint(hint)
    })().catch(() => {
      if (!cancelled) {
        setModelGroups([])
        setModelHint(t('settings.cron.modelsLoadFailed', 'Failed to load models.'))
      }
    })

    return () => {
      cancelled = true
    }
  }, [open, activeScope, selectedWorkspacePath, teamId, daemonHttpReady, runtimeModelSignature, t])

  // Drop a saved model that is no longer in this workspace's catalog, clearing
  // its pinned backend too so the job reverts to the "auto" default.
  React.useEffect(() => {
    if (!open || !form.model || modelOptions.length === 0) return
    if (!backendByRef.has(form.model)) {
      setForm((prev) => ({ ...prev, model: '', backend: '' }))
    }
  }, [open, form.model, modelOptions.length, backendByRef])

  // Pre-fill a new job from the device default (Settings → LLM → Model
  // defaults). Deliberately a pre-fill and not a run-time fallback: the job
  // still stores a concrete model, so changing the default later never moves an
  // existing job (ADR-0007, and the `requiredModel` guard below).
  //
  // Runs after the catalog loads rather than on open, so a default naming a
  // model this workspace cannot run is simply not applied — the effect above
  // would otherwise clear it a tick later and the field would visibly flicker.
  React.useEffect(() => {
    if (!open || editJob || form.model || modelOptions.length === 0) return
    const preset = automationDefaultForBackends(new Set(backendByRef.values()), teamId)
    if (!preset || !backendByRef.has(preset)) return
    setForm((prev) => ({ ...prev, model: preset, backend: backendByRef.get(preset) ?? '' }))
  }, [open, editJob, form.model, modelOptions.length, backendByRef, teamId])

  React.useEffect(() => {
    if (open) {
      if (editJob) {
        const next = jobToFormState(editJob)
        setForm(next)
        setAdvancedOptionsOpen(next.deliveryEnabled)
      } else {
        setForm(defaultFormState)
        setAdvancedOptionsOpen(false)
      }
      setError(null)
    }
  }, [open, editJob])

  // Scroll only when the user toggles the advanced section open (not when it opens via edit load).
  const onAdvancedOptionsOpenChange = React.useCallback((nextOpen: boolean) => {
    setAdvancedOptionsOpen(nextOpen)
    if (!nextOpen) return
    window.setTimeout(() => {
      advancedScrollAnchorRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest',
      })
    }, 100)
  }, [])

  const update = (partial: Partial<JobFormState>) => {
    setForm((prev) => ({ ...prev, ...partial }))
  }

  // Build available channels dynamically from registry
  const availableChannels = DELIVERY_CHANNEL_REGISTRY
    .filter((entry) => entry.getEnabled(channelsStore))
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      connected: entry.getConnected(channelsStore),
    }))
  const availableChannelIds = availableChannels.map((ch) => ch.id).join(',')

  // If Delivery is on but the selected channel is not enabled, jump to the
  // first available one (e.g. SeaTalk-only setups still defaulted to Discord).
  React.useEffect(() => {
    if (!form.deliveryEnabled || availableChannels.length === 0) return
    if (availableChannels.some((ch) => ch.id === form.deliveryChannel)) return
    const first = availableChannels[0]
    const entry = getRegistryEntry(first.id)
    setForm((prev) => ({
      ...prev,
      deliveryChannel: first.id,
      deliveryTargetMode: entry?.modes?.[0]?.value || '',
      deliveryTargetValues: {},
    }))
  }, [form.deliveryEnabled, form.deliveryChannel, availableChannelIds])

  const handleSave = async () => {
    if (!form.name.trim()) {
      setError(t('settings.cron.requiredName', 'Job name is required'))
      return
    }
    if (!form.message.trim()) {
      setError(t('settings.cron.requiredMessage', 'Prompt message is required'))
      return
    }
    if (form.scheduleKind === 'at' && !form.at) {
      setError(t('settings.cron.requiredDateTime', 'Date & Time is required for one-time schedule'))
      return
    }
    if (form.scheduleKind === 'cron' && !form.cronExpr.trim()) {
      setError(t('settings.cron.requiredCron', 'Cron expression is required'))
      return
    }
    // Every automation entry point pins a model at creation time (ADR-0007).
    // The old "use default model" path resolved at run time against the device
    // MRU, so the same job ran on whatever model this device happened to have
    // used last — and on a different device, a different model.
    if (!form.model.trim()) {
      setError(t('settings.cron.requiredModel', 'Model is required'))
      return
    }
    if (form.deliveryEnabled) {
      const entry = getRegistryEntry(form.deliveryChannel)
      if (entry) {
        const fieldDefs = Array.isArray(entry.fields)
          ? entry.fields
          : (entry.fields[form.deliveryTargetMode] || [])
        for (const field of fieldDefs) {
          if (field.required && !form.deliveryTargetValues[field.key]?.trim()) {
            setError(`${field.label} is required`)
            return
          }
        }
      }
    }

    setSaving(true)
    setError(null)

    const payloadForm =
      form

    try {
      if (editJob) {
        const request: UpdateCronJobRequest = {
          id: editJob.id,
          name: form.name,
          description: undefined,
          enabled: form.enabled,
          schedule: formStateToSchedule(form),
          payload: formStateToPayload(payloadForm),
          delivery: form.deliveryEnabled ? formStateToDelivery(form) : null,
          deleteAfterRun: form.deleteAfterRun,
        }
        await updateJob(request)
      } else {
        const request: CreateCronJobRequest = {
          name: form.name,
          description: undefined,
          enabled: form.enabled,
          schedule: formStateToSchedule(form),
          payload: formStateToPayload(payloadForm),
          delivery: formStateToDelivery(form),
          deleteAfterRun: form.deleteAfterRun,
        }
        const newJob = await addJob(request)

        // Trigger immediate run for recurring jobs if requested
        if (
          form.runImmediately &&
          (form.scheduleKind === 'every' || form.scheduleKind === 'cron')
        ) {
          try {
            await runJob(newJob.id)
          } catch {
            // Non-fatal: job was created successfully, immediate run failed
            console.warn('[Cron] Immediate run failed, job was still created')
          }
        }
      }
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent ref={dialogContentRef} className="sm:max-w-[720px] max-h-[85vh]">
        <DialogHeader>
          <DialogTitle>{editJob ? t('settings.cron.editJob', 'Edit Job') : t('settings.cron.createJob', 'Create New Job')}</DialogTitle>
          <DialogDescription>
            {editJob
              ? t('settings.cron.editJobDesc', 'Modify the scheduled task configuration.')
              : t('settings.cron.createJobDesc', 'Set up a new automated task for your AI agent.')}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh] pr-4">
          <div className="space-y-6 py-2">
            {activeScope === 'global' && (
              <p className="rounded-lg border border-border-soft bg-panel/50 px-3 py-2 text-[12px] text-muted-foreground leading-relaxed">
                {t(
                  'settings.cron.globalJobNote',
                  'Global tasks run in the daemon default workspace. Changing the default updates future runs.',
                )}
              </p>
            )}

            {/* Section 1: Basic Info */}
            <div className="space-y-3">
              <div className="space-y-2">
                <label className="text-[13px] font-medium">{t('settings.cron.name', 'Name')} *</label>
                <Input
                  value={form.name}
                  onChange={(e) => update({ name: e.target.value })}
                  placeholder={t('settings.cron.namePlaceholder', 'e.g., Approval Checker')}
                />
              </div>
              <div className="space-y-2">
                <label className="text-[13px] font-medium">{t('settings.cron.prompt', 'Prompt')} *</label>
                <div
                  className={cn(
                    'rounded-md border border-input bg-background shadow-xs overflow-hidden',
                    'focus-within:border-ring focus-within:ring-[1.5px] focus-within:ring-ring/50 focus-within:ring-inset',
                  )}
                >
                  <Textarea
                    value={form.message}
                    onChange={(e) => update({ message: e.target.value })}
                    placeholder={t('settings.cron.promptPlaceholder', 'Describe what the AI agent should do...')}
                    rows={8}
                    className="resize-none min-h-[220px] rounded-none border-0 shadow-none focus-visible:ring-0 focus-visible:border-0 bg-transparent py-3"
                  />
                  <div className="flex flex-wrap items-center gap-1.5 border-t border-border/70 px-2 py-1 bg-muted/30 dark:bg-muted/15">
                    <Box className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                    <Popover open={modelMenuOpen} onOpenChange={setModelMenuOpen}>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          title={
                            form.model
                              ? t('settings.cron.modelSelected', `Using: ${form.model}`)
                              : t('settings.cron.modelRequiredHint', 'Pick the model this job runs on.')
                          }
                          className={cn(
                            'flex h-7 min-h-7 w-fit max-w-[min(100%,18rem)] shrink items-center justify-start gap-1 rounded-md px-1.5 py-0 font-mono text-xs',
                            'hover:bg-muted/60 focus:outline-none data-[state=open]:bg-muted/60',
                            !form.model && 'italic text-muted-foreground',
                          )}
                        >
                          <span className="truncate">
                            {form.model || t('settings.cron.selectModel', 'Select a model')}
                          </span>
                          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent
                        align="start"
                        sideOffset={6}
                        container={dialogContentRef.current ?? undefined}
                        className="w-[18rem] p-0"
                        // This popover is nested inside a Radix Dialog. The
                        // command input's default autofocus moves focus into
                        // content portaled to `document.body`, outside the
                        // Dialog's DOM subtree; the Dialog's FocusScope then
                        // yanks focus back, which the popover reads as an
                        // outside interaction and immediately closes itself.
                        // Skipping the auto-focus breaks that fight.
                        onOpenAutoFocus={(e) => e.preventDefault()}
                      >
                        <ModelPickerCommand
                          models={pickerModels}
                          selectedId={form.model}
                          onSelect={(id) => {
                            update({ model: id, backend: backendByRef.get(id) ?? '' })
                            setModelMenuOpen(false)
                          }}
                          // No "use default model" entry any more: a job with no
                          // model resolved at run time against the device MRU,
                          // so the same job ran on a different model depending
                          // on which device and which directory picked it up
                          // (ADR-0007). The choice is made here or nowhere.
                          emptyState={
                            modelHint ? (
                              <div className="px-2 py-4 text-center text-[12.5px] text-muted-foreground">
                                {modelHint}
                              </div>
                            ) : (
                              <div className="px-2 py-6 text-center text-[13px] text-muted-foreground">
                                {t('settings.cron.noModels', 'No models advertised. Start an agent session in chat first, or configure providers in LLM settings.')}
                              </div>
                            )
                          }
                        />
                      </PopoverContent>
                    </Popover>
                  </div>
                </div>
              </div>
            </div>

            {/* Section 2: Schedule — type + mode fields on one row */}
            <div className="space-y-3">
              <h4 className="text-[13px] font-semibold flex items-center gap-2 text-muted-foreground uppercase tracking-wide">
                <Timer className="h-3.5 w-3.5" />
                {t('settings.cron.schedule', 'Schedule')}
              </h4>
              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1 min-w-0 flex-1 basis-[11rem]">
                  <label className="text-xs text-muted-foreground">
                    {t('settings.cron.scheduleType', 'Schedule Type')}
                  </label>
                  <Select
                    value={form.scheduleKind}
                    onValueChange={(v: ScheduleKind) => {
                      const updates: Partial<JobFormState> = { scheduleKind: v }
                      if (v !== 'at') {
                        updates.deleteAfterRun = false
                      }
                      if (v === 'at' && !form.at) {
                        const defaultAt = new Date(Date.now() + 30 * 60 * 1000)
                        updates.at = defaultAt.toISOString()
                      }
                      update(updates)
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="every">{t('settings.cron.intervalRecurring', 'Interval (Recurring)')}</SelectItem>
                      <SelectItem value="cron">{t('settings.cron.cronExpr', 'Cron Expression')}</SelectItem>
                      <SelectItem value="at">{t('settings.cron.oneTime', 'One-time')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {form.scheduleKind === 'every' && (
                  <>
                    <div className="space-y-1 w-[4.25rem] shrink-0">
                      <label className="text-xs text-muted-foreground">{t('settings.cron.interval', 'Interval')}</label>
                      <Input
                        type="number"
                        min={1}
                        className="tabular-nums"
                        value={form.everyValue}
                        onChange={(e) =>
                          update({ everyValue: parseInt(e.target.value, 10) || 1 })
                        }
                      />
                    </div>
                    <div className="space-y-1 min-w-[6.5rem] flex-1 basis-[6.5rem] max-w-[11rem]">
                      <label className="text-xs text-muted-foreground">{t('settings.cron.unit', 'Unit')}</label>
                      <Select
                        value={form.everyUnit}
                        onValueChange={(v: 'minutes' | 'hours' | 'days') =>
                          update({ everyUnit: v })
                        }
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="minutes">{t('settings.cron.minutes', 'Minutes')}</SelectItem>
                          <SelectItem value="hours">{t('settings.cron.hours', 'Hours')}</SelectItem>
                          <SelectItem value="days">{t('settings.cron.days', 'Days')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </>
                )}

                {form.scheduleKind === 'cron' && (
                  <>
                    <div className="space-y-1 min-w-0 flex-1 basis-[10rem]">
                      <label className="text-xs text-muted-foreground">
                        {t('settings.cron.cronExprLabel', 'Cron Expression')} *
                      </label>
                      <Input
                        value={form.cronExpr}
                        onChange={(e) => update({ cronExpr: e.target.value })}
                        placeholder="*/30 * * * *"
                        className="font-mono w-full"
                      />
                    </div>
                    <div className="space-y-1 min-w-[7rem] w-40 shrink-0 sm:w-44">
                      <label className="text-xs text-muted-foreground">
                        {t('settings.cron.timezone', 'Timezone (optional)')}
                      </label>
                      <Input
                        value={form.cronTz}
                        onChange={(e) => update({ cronTz: e.target.value })}
                        placeholder="Asia/Singapore"
                        className="w-full"
                      />
                    </div>
                  </>
                )}

                {form.scheduleKind === 'at' && (
                  <div className="space-y-1 min-w-0 flex-1 basis-[14rem]">
                    <label className="text-xs text-muted-foreground">{t('settings.cron.dateTime', 'Date & Time')} *</label>
                    <Input
                      type="datetime-local"
                      className="w-full"
                      value={isoToLocalDatetime(form.at)}
                      onChange={(e) => {
                        const val = e.target.value
                        update({ at: localDatetimeToIso(val) })
                      }}
                    />
                  </div>
                )}
              </div>

              {form.scheduleKind === 'every' && (
                <div className="space-y-2">
                  {!editJob && (
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="runImmediatelyEvery"
                        checked={form.runImmediately}
                        onChange={(e) => update({ runImmediately: e.target.checked })}
                        className="rounded"
                      />
                      <label htmlFor="runImmediatelyEvery" className="text-[13px]">
                        {t('settings.cron.runImmediately', 'Run immediately after creation')}
                      </label>
                    </div>
                  )}
                  {!form.runImmediately && !editJob && (
                    <p className="text-xs text-muted-foreground">
                      First run will be in {form.everyValue}{' '}
                      {form.everyUnit === 'minutes'
                        ? 'min'
                        : form.everyUnit === 'hours'
                          ? 'hour(s)'
                          : 'day(s)'}{' '}
                      from now.
                    </p>
                  )}
                </div>
              )}

              {form.scheduleKind === 'cron' && (
                <div className="space-y-2">
                  {!editJob && (
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="runImmediatelyCron"
                        checked={form.runImmediately}
                        onChange={(e) => update({ runImmediately: e.target.checked })}
                        className="rounded"
                      />
                      <label htmlFor="runImmediatelyCron" className="text-[13px]">
                        {t('settings.cron.runImmediately', 'Run immediately after creation')}
                      </label>
                    </div>
                  )}
                </div>
              )}
            </div>

            <Collapsible open={advancedOptionsOpen} onOpenChange={onAdvancedOptionsOpenChange}>
              <CollapsibleTrigger
                type="button"
                className={cn(
                  'flex w-full items-center gap-3 py-3',
                  'border-0 bg-transparent shadow-none outline-none ring-0 ring-offset-0',
                  'text-muted-foreground hover:text-foreground transition-colors',
                  'focus-visible:text-foreground',
                )}
              >
                <span className="h-px min-w-0 flex-1 bg-border" aria-hidden />
                <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium uppercase tracking-wide">
                  <ChevronDown
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 transition-transform duration-200',
                      advancedOptionsOpen && 'rotate-180',
                    )}
                    aria-hidden
                  />
                  {t('settings.cron.advancedOptions', 'Advanced options')}
                </span>
                <span className="h-px min-w-0 flex-1 bg-border" aria-hidden />
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-4">
                <div ref={advancedScrollAnchorRef} className="scroll-mt-2 space-y-6">
            {/* Section 3: Execution */}
            <div className="space-y-3">
              <h4 className="text-[13px] font-semibold flex items-center gap-2 text-muted-foreground uppercase tracking-wide">
                <SlidersHorizontal className="h-3.5 w-3.5" />
                {t('settings.cron.execution', 'Execution')}
              </h4>
              {/* Full access — on by default: a scheduled run has nobody to
                  approve a tool prompt, so asking just stalls it. */}
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-[13px] font-medium">
                    {t('settings.cron.fullAccess', 'Full access')}
                  </label>
                  <p className="text-xs text-muted-foreground">
                    {form.permissionMode === 'full_access'
                      ? t(
                          'settings.cron.fullAccessDesc',
                          'Approve tool use automatically. Scheduled runs have nobody to answer a prompt.',
                        )
                      : t(
                          'settings.cron.fullAccessOffDesc',
                          'Ask for approval. The run waits until someone answers, or times out.',
                        )}
                  </p>
                </div>
                <ToggleSwitch
                  enabled={form.permissionMode === 'full_access'}
                  onChange={(v) => update({ permissionMode: v ? 'full_access' : 'default' })}
                />
              </div>

            </div>

            {/* Section 4: Delivery */}
            <div className="space-y-3">
              <h4 className="text-[13px] font-semibold flex items-center gap-2 text-muted-foreground uppercase tracking-wide">
                <Send className="h-3.5 w-3.5" />
                {t('settings.cron.delivery', 'Delivery')}
              </h4>
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-[13px] font-medium">{t('settings.cron.enableDelivery', 'Enable Delivery')}</label>
                  <p className="text-xs text-muted-foreground">
                    {t('settings.cron.enableDeliveryDesc', 'Send results to a channel after execution')}
                  </p>
                </div>
                <ToggleSwitch
                  enabled={form.deliveryEnabled}
                  onChange={(v) => update({ deliveryEnabled: v })}
                />
              </div>

              {form.deliveryEnabled && (
                <div className="space-y-3 pl-4 border-l-2 border-muted">
                  <div className="space-y-2">
                    <label className="text-[13px] font-medium">{t('settings.cron.channel', 'Channel')}</label>
                    {availableChannels.length === 0 ? (
                      <p className="text-[13px] text-muted-foreground">
                        {t('settings.cron.noChannels', 'No channels configured. Please set up a channel in the Channels section first.')}
                      </p>
                    ) : (
                      <Select
                        value={form.deliveryChannel}
                        onValueChange={(v: DeliveryChannel) => {
                          const entry = getRegistryEntry(v)
                          const nextMode = entry?.modes?.[0]?.value || ''
                          update({
                            deliveryChannel: v,
                            deliveryTargetMode: nextMode,
                            deliveryTargetValues: {},
                          })
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {availableChannels.map((ch) => (
                            <SelectItem key={ch.id} value={ch.id}>
                              <span className="flex items-center gap-2">
                                {ch.name}
                                {ch.connected ? (
                                  <span className="text-green-500 text-xs">
                                    ({t('settings.channels.connected', 'connected')})
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground text-xs">
                                    ({t('settings.channels.disconnected', 'disconnected')})
                                  </span>
                                )}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>

                  {/* Dynamic channel-specific fields from registry */}
                  {availableChannels.length > 0 && (() => {
                    const entry = getRegistryEntry(form.deliveryChannel)
                    if (!entry) return null

                    const hasModes = !!entry.modes
                    const currentMode = form.deliveryTargetMode
                    const fieldDefs = Array.isArray(entry.fields)
                      ? entry.fields
                      : (entry.fields[currentMode] || [])

                    return (
                      <div className="space-y-3">
                        {hasModes && entry.modes && (
                          <div className="space-y-2">
                            <label className="text-[13px] font-medium">{t('settings.cron.deliveryMode', 'Delivery Mode')}</label>
                            <Select
                              value={currentMode}
                              onValueChange={(v) =>
                                update({ deliveryTargetMode: v, deliveryTargetValues: {} })
                              }
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {entry.modes.map((m) => (
                                  <SelectItem key={m.value} value={m.value}>
                                    {m.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                        {form.deliveryChannel === 'wecom' && (
                          <WeComChatPicker
                            selected={
                              currentMode === 'group'
                                ? form.deliveryTargetValues.chatId
                                : form.deliveryTargetValues.userId
                            }
                            onPick={(chat) =>
                              update({
                                deliveryTargetMode: chat.chatType === 'group' ? 'group' : 'single',
                                deliveryTargetValues:
                                  chat.chatType === 'group'
                                    ? { chatId: chat.chatId }
                                    : { userId: chat.chatId },
                              })
                            }
                          />
                        )}
                        {fieldDefs.map((field) => (
                          <div key={field.key} className="space-y-2">
                            <label className="text-[13px] font-medium">
                              {field.label} {field.required && '*'}
                            </label>
                            <Input
                              type={field.type || 'text'}
                              value={form.deliveryTargetValues[field.key] || ''}
                              onChange={(e) =>
                                update({
                                  deliveryTargetValues: {
                                    ...form.deliveryTargetValues,
                                    [field.key]: e.target.value,
                                  },
                                })
                              }
                              placeholder={field.placeholder}
                              className={cn(field.type !== 'email' && 'font-mono', 'text-xs')}
                            />
                            <p className="text-xs text-muted-foreground">{field.hint}</p>
                          </div>
                        ))}
                      </div>
                    )
                  })()}

                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="bestEffort"
                      checked={form.deliveryBestEffort}
                      onChange={(e) =>
                        update({ deliveryBestEffort: e.target.checked })
                      }
                      className="rounded"
                    />
                    <label htmlFor="bestEffort" className="text-[13px]">
                      {t('settings.cron.bestEffort', "Best effort (don't fail job if delivery fails)")}
                    </label>
                  </div>
                </div>
              )}
            </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </ScrollArea>

        {error && (
          <div className="flex items-center gap-2 text-[13px] text-destructive px-1">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {editJob ? t('settings.cron.saveChanges', 'Save Changes') : t('settings.cron.createJob', 'Create Job')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
