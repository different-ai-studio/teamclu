import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ModalShell } from '@/components/teamshare/skill-detail/ModalShell'

export interface WikiSourceDirectory {
  path: string
  label: string
}

export interface WikiCompilerModel {
  id: string
  name: string
  providerName?: string
}

export interface WikiPrepareSummary {
  runId: string
  sourceCount: number
  retractCount?: number
  added: number
  updated: number
  deleted: number
  failed: number
  visionPages: number
  estimatedCost: number | null
  currency: string
  canPublish: boolean
  blockers: string[]
}

export interface WikiPublishResult {
  syncStatus: 'synced' | 'published_local_sync_pending' | string
}

export type WikiCompileProgress = {
  stage: 'plan' | 'estimate' | 'ingest' | 'lint' | 'done' | string
  path?: string
  action?: string
  current?: number
  total?: number
}

type Phase = 'select' | 'preparing' | 'summary' | 'publishing' | 'published'

const STAGES = ['plan', 'estimate', 'ingest', 'lint', 'done'] as const

async function defaultSubscribeProgress(
  handler: (event: WikiCompileProgress) => void,
): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event')
  return listen<WikiCompileProgress>('kb-maintainer:progress', (event) => {
    handler(event.payload)
  })
}

function compilerModelGroups(models: WikiCompilerModel[]): {
  label: string
  models: WikiCompilerModel[]
}[] {
  const groups = new Map<string, WikiCompilerModel[]>()
  for (const model of models) {
    const label = model.providerName?.trim() || ''
    const list = groups.get(label)
    if (list) list.push(model)
    else groups.set(label, [model])
  }
  return [...groups.entries()].map(([label, groupModels]) => ({
    label,
    models: groupModels,
  }))
}

function stageLabel(
  stage: string,
  t: (key: string, fallback: string) => string,
): string {
  switch (stage) {
    case 'plan':
      return t('teamShare.wikiStepPlan', 'Checking source plan')
    case 'estimate':
      return t('teamShare.wikiStepEstimate', 'Estimating vision cost')
    case 'ingest':
      return t('teamShare.wikiStepIngest', 'Compiling sources')
    case 'lint':
      return t('teamShare.wikiStepLint', 'Checking wiki quality')
    case 'done':
      return t('teamShare.wikiStepDone', 'Preparing summary')
    default:
      return stage
  }
}

export function WikiMaintainerRunSheet({
  open,
  teamId,
  sourceDirectories,
  compilerModels = [],
  initialSelected,
  initialCompilerModel = '',
  onSaveSelection,
  onSaveCompilerModel,
  onPrepare,
  onPublish,
  onCancel,
  onClose,
  subscribeProgress,
}: {
  open: boolean
  teamId: string
  sourceDirectories: WikiSourceDirectory[]
  compilerModels?: WikiCompilerModel[]
  initialSelected: string[]
  initialCompilerModel?: string
  onSaveSelection: (teamId: string, paths: string[]) => void
  onSaveCompilerModel?: (teamId: string, modelId: string) => void
  onPrepare: (
    teamId: string,
    paths: string[],
    compilerModel: string,
  ) => Promise<WikiPrepareSummary>
  onPublish: (runId: string, acceptVisionCost: boolean) => Promise<WikiPublishResult>
  onCancel?: (runId: string) => Promise<void>
  onClose: () => void
  subscribeProgress?: (
    handler: (event: WikiCompileProgress) => void,
  ) => (() => void) | Promise<() => void>
}) {
  const { t } = useTranslation()
  const [selected, setSelected] = React.useState<string[]>(initialSelected)
  const [compilerModel, setCompilerModel] = React.useState(initialCompilerModel)
  const [phase, setPhase] = React.useState<Phase>('select')
  const [summary, setSummary] = React.useState<WikiPrepareSummary | null>(null)
  const [publishResult, setPublishResult] = React.useState<WikiPublishResult | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [costAccepted, setCostAccepted] = React.useState(false)
  const [progress, setProgress] = React.useState<WikiCompileProgress | null>(null)

  React.useEffect(() => {
    if (!open) return
    setSelected(initialSelected)
    setCompilerModel(initialCompilerModel)
    setPhase('select')
    setSummary(null)
    setPublishResult(null)
    setError(null)
    setCostAccepted(false)
    setProgress(null)
    // Persist a new selection while the sheet is open; do not reset on that
    // array identity change or the user would lose in-progress folder picks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  React.useEffect(() => {
    if (phase !== 'preparing') return
    let cancelled = false
    let unsub: (() => void) | undefined
    const subscribe = subscribeProgress ?? defaultSubscribeProgress
    void Promise.resolve(subscribe((event) => {
      if (!cancelled) setProgress(event)
    })).then((dispose) => {
      if (cancelled) {
        dispose()
        return
      }
      unsub = dispose
    })
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [phase, subscribeProgress])

  const busy = phase === 'preparing' || phase === 'publishing'
  const togglePath = (path: string) => {
    setSelected((current) =>
      current.includes(path) ? current.filter((item) => item !== path) : [...current, path],
    )
  }
  const prepare = async () => {
    setError(null)
    setProgress({ stage: 'plan' })
    setPhase('preparing')
    try {
      onSaveSelection(teamId, selected)
      onSaveCompilerModel?.(teamId, compilerModel)
      const next = await onPrepare(teamId, selected, compilerModel)
      setSummary(next)
      setProgress(null)
      setPhase('summary')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setProgress(null)
      setPhase('select')
    }
  }

  if (!open) return null

  const publish = async () => {
    if (!summary?.canPublish) return
    setError(null)
    setPhase('publishing')
    try {
      const result = await onPublish(summary.runId, costAccepted)
      setPublishResult(result)
      setPhase('published')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setPhase('summary')
    }
  }
  const close = () => {
    if (busy) return
    if (summary && phase !== 'published') {
      void onCancel?.(summary.runId)
    }
    onClose()
  }
  const changeSources = async () => {
    if (!summary) return
    setError(null)
    try {
      if (summary.canPublish) {
        await onCancel?.(summary.runId)
      }
      setSummary(null)
      setCostAccepted(false)
      setPhase('select')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const activeStage = progress?.stage ?? 'plan'
  const activeIndex = Math.max(0, STAGES.indexOf(activeStage as (typeof STAGES)[number]))

  return (
    <ModalShell
      title={t('teamShare.wikiMaintainTitle', 'Maintain Wiki')}
      hint={t(
        'teamShare.wikiMaintainHint',
        'Choose source folders, then check and compile. Nothing is published until you confirm.',
      )}
      onClose={close}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={close} disabled={busy}>
            {phase === 'published' ? t('common.close', 'Close') : t('common.cancel', 'Cancel')}
          </Button>
          {(phase === 'select' || phase === 'preparing') && (
            <Button type="button" onClick={() => void prepare()} disabled={busy || selected.length === 0 || !compilerModel}>
              {phase === 'preparing' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('teamShare.wikiCheckCompile', 'Check and compile')}
            </Button>
          )}
          {(phase === 'summary' || phase === 'publishing') && (
            <Button
              type="button"
              onClick={() => void publish()}
              disabled={
                busy ||
                !summary?.canPublish ||
                (!!summary.estimatedCost && !costAccepted)
              }
            >
              {phase === 'publishing' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('teamShare.wikiConfirmPublish', 'Confirm publish')}
            </Button>
          )}
        </>
      }
    >
      {phase === 'select' && (
        <div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">
            {t('teamShare.wikiSourceFolders', 'Source folders')}
          </div>
          <div className="space-y-1">
            {sourceDirectories.map((directory) => (
              <label
                key={directory.path}
                className="flex items-center gap-2 rounded-[8px] px-2 py-2 text-[13px] hover:bg-selected"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(directory.path)}
                  onChange={() => togglePath(directory.path)}
                  aria-label={directory.label}
                />
                <span className="min-w-0 flex-1 truncate">{directory.label}</span>
                <span className="font-mono text-[10.5px] text-faint">{directory.path}</span>
              </label>
            ))}
          </div>
          <div className="mt-4">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">
              {t('teamShare.wikiCompilerModel', 'Compiler model')}
            </div>
            <select
              className="h-8 w-full rounded-[8px] border border-border bg-paper px-2 text-[13px] text-foreground"
              value={compilerModel}
              onChange={(event) => {
                const next = event.target.value
                setCompilerModel(next)
                onSaveCompilerModel?.(teamId, next)
              }}
              aria-label={t('teamShare.wikiCompilerModel', 'Compiler model')}
              disabled={compilerModels.length === 0}
            >
              {compilerModels.length === 0 && (
                <option value="">
                  {t('teamShare.wikiCompilerModelEmpty', 'No models available')}
                </option>
              )}
              {compilerModelGroups(compilerModels).map((group) =>
                group.label ? (
                  <optgroup key={group.label} label={group.label}>
                    {group.models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name || model.id}
                      </option>
                    ))}
                  </optgroup>
                ) : (
                  group.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name || model.id}
                    </option>
                  ))
                ),
              )}
            </select>
            {compilerModels.length === 0 && (
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
                {t(
                  'teamShare.wikiCompilerModelHint',
                  'Sign in a model provider, or configure team AI, then compile Wiki.',
                )}
              </p>
            )}
          </div>
          <p className="mt-3 text-[11.5px] leading-relaxed text-muted-foreground">
            {t(
              'teamShare.wikiSingleMaintainerWarning',
              'Do not maintain this Wiki from another computer at the same time.',
            )}
          </p>
        </div>
      )}

      {phase === 'preparing' && (
        <div className="space-y-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-faint">
            {t('teamShare.wikiCompileProgress', 'Compile progress')}
          </div>
          <div className="space-y-1.5">
            {STAGES.map((stage, index) => {
              const done = index < activeIndex || activeStage === 'done'
              const active = stage === activeStage && activeStage !== 'done'
              return (
                <div
                  key={stage}
                  className={`flex items-start gap-2 rounded-[8px] px-3 py-2 text-[12.5px] ${
                    active ? 'bg-panel text-foreground' : 'text-muted-foreground'
                  }`}
                >
                  {done ? (
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                  ) : active ? (
                    <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
                  ) : (
                    <span className="mt-0.5 inline-block h-3.5 w-3.5 shrink-0 rounded-full border border-border" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div>{stageLabel(stage, t)}</div>
                    {active && stage === 'ingest' && progress?.path && (
                      <div className="mt-0.5 truncate font-mono text-[11px] text-faint">
                        {progress.current && progress.total
                          ? `${progress.current} / ${progress.total} · ${
                              progress.action === 'delete'
                                ? t('teamShare.wikiActionRetract', 'retract')
                                : t('teamShare.wikiActionCompile', 'compile')
                            } · ${progress.path}`
                          : progress.path}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {summary && (phase === 'summary' || phase === 'publishing' || phase === 'published') && (
        <div className="space-y-3">
          {phase === 'summary' && (
            <Button
              type="button"
              variant="ghost"
              className="h-7 px-2 text-[11.5px]"
              onClick={() => void changeSources()}
            >
              {t('teamShare.wikiChangeSources', 'Change source folders')}
            </Button>
          )}
          <div className="grid grid-cols-2 gap-2 text-[12.5px]">
            <SummaryItem
              text={t('teamShare.wikiSourcesChecked', '{{count}} source files checked', {
                count: summary.sourceCount,
              })}
            />
            {(summary.retractCount ?? 0) > 0 && (
              <SummaryItem
                text={t('teamShare.wikiSourcesRetracted', '{{count}} deleted sources retracted', {
                  count: summary.retractCount,
                })}
              />
            )}
            <SummaryItem
              text={t('teamShare.wikiPagesAdded', '{{count}} pages added', {
                count: summary.added,
              })}
            />
            <SummaryItem
              text={t('teamShare.wikiPagesUpdated', '{{count}} pages updated', {
                count: summary.updated,
              })}
            />
            <SummaryItem
              text={t('teamShare.wikiPagesDeleted', '{{count}} pages deleted', {
                count: summary.deleted,
              })}
            />
            <SummaryItem
              text={t('teamShare.wikiSourcesFailed', '{{count}} source failed', {
                count: summary.failed,
              })}
            />
            {summary.visionPages > 0 && (
              <SummaryItem
                text={t(
                  'teamShare.wikiVisionEstimate',
                  '{{pages}} vision pages · {{cost}} {{currency}}',
                  {
                    pages: summary.visionPages,
                    cost: summary.estimatedCost ?? '?',
                    currency: summary.currency,
                  },
                )}
              />
            )}
          </div>
          {!!summary.estimatedCost && (
            <label className="flex items-center gap-2 rounded-[8px] border border-border px-3 py-2 text-[12px]">
              <input
                type="checkbox"
                checked={costAccepted}
                onChange={(event) => setCostAccepted(event.target.checked)}
                aria-label={t(
                  'teamShare.wikiAcceptVisionCost',
                  'Accept estimated vision cost',
                )}
              />
              {t(
                'teamShare.wikiAcceptVisionCostDetail',
                'Accept the estimated visual recognition cost before publishing.',
              )}
            </label>
          )}
          {summary.blockers.length > 0 && (
            <div className="rounded-[8px] border border-destructive/30 bg-destructive/5 p-3">
              {summary.blockers.map((blocker) => (
                <div key={blocker} className="flex gap-2 text-[12px] text-destructive">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{blocker}</span>
                </div>
              ))}
            </div>
          )}
          {summary.canPublish && summary.failed > 0 && (
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              {t(
                'teamShare.wikiPartialPublish',
                'Pages that passed are saved. You can publish them now. Failed sources are left out and can be compiled again later.',
              )}
            </p>
          )}
          {phase === 'published' && (
            <div className="flex items-center gap-2 rounded-[8px] border border-border bg-panel p-3 text-[12.5px]">
              <Check className="h-4 w-4 text-emerald-600" />
              {publishResult?.syncStatus === 'synced'
                ? t('teamShare.wikiPublishedSynced', 'Published and synced')
                : t(
                    'teamShare.wikiPublishedPending',
                    'Published locally. Team sync still needs attention.',
                  )}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-[8px] border border-destructive/30 bg-destructive/5 p-3 text-[12px] text-destructive">
          {error}
        </div>
      )}
    </ModalShell>
  )
}

function SummaryItem({ text }: { text: string }) {
  return <div className="rounded-[8px] border border-border-soft bg-panel px-3 py-2">{text}</div>
}
