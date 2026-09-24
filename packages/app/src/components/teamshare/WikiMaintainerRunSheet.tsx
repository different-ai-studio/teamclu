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
  nodeId?: string
  baseTreeHash?: string | null
  targetCommit?: string
  targetTreeHash?: string
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
  needsVisionAcceptance?: boolean
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

type Phase =
  | 'select'
  | 'waiting_for_model'
  | 'vision'
  | 'preparing'
  | 'summary'
  | 'publishing'
  | 'published'

const NO_PAGES_SENTENCE = 'The compiler did not write a Wiki page for this source.'
const SKIPPED_SENTENCE =
  'This source was skipped this run and will be compiled again next time.'

function takePrefixed(blocker: string, sentence: string): string | null {
  if (blocker === sentence) return ''
  const suffix = `: ${sentence}`
  if (!blocker.endsWith(suffix)) return null
  return blocker.slice(0, -suffix.length)
}

function groupBlockers(blockers: string[]) {
  const noPages: string[] = []
  const skipped: string[] = []
  let skippedCount = 0
  const rest: string[] = []
  for (const blocker of blockers) {
    const noPagePath = takePrefixed(blocker, NO_PAGES_SENTENCE)
    if (noPagePath !== null) {
      if (noPagePath) noPages.push(noPagePath)
      continue
    }
    const skippedPath = takePrefixed(blocker, SKIPPED_SENTENCE)
    if (skippedPath !== null) {
      skippedCount += 1
      if (skippedPath) skipped.push(skippedPath)
      continue
    }
    rest.push(blocker)
  }
  return { noPages, skipped, skippedCount, rest }
}

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
  initialSummary = null,
  checkpointModel = '',
  needsAdopt = false,
  onAdopt,
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
  initialSummary?: WikiPrepareSummary | null
  checkpointModel?: string
  needsAdopt?: boolean
  onAdopt?: (teamId: string) => Promise<void>
  onSaveSelection: (teamId: string, paths: string[]) => void
  onSaveCompilerModel?: (teamId: string, modelId: string) => void
  onPrepare: (
    teamId: string,
    paths: string[],
    compilerModel: string,
    visionChoice?: 'accept' | 'decline',
  ) => Promise<WikiPrepareSummary>
  onPublish: (
    teamId: string,
    summary: WikiPrepareSummary,
    acceptVisionCost: boolean,
  ) => Promise<WikiPublishResult>
  onCancel?: (runId: string) => Promise<void>
  onClose: () => void
  subscribeProgress?: (
    handler: (event: WikiCompileProgress) => void,
  ) => (() => void) | Promise<() => void>
}) {
  const { t } = useTranslation()
  const [selected, setSelected] = React.useState<string[]>(initialSelected)
  const [compilerModel, setCompilerModel] = React.useState(initialCompilerModel)
  const modelMissing =
    checkpointModel !== '' &&
    !compilerModels.some((model) => model.id === checkpointModel)
  const [phase, setPhase] = React.useState<Phase>(
    initialSummary ? 'summary' : modelMissing ? 'waiting_for_model' : 'select',
  )
  const [summary, setSummary] = React.useState<WikiPrepareSummary | null>(
    initialSummary,
  )
  const [publishResult, setPublishResult] = React.useState<WikiPublishResult | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [progress, setProgress] = React.useState<WikiCompileProgress | null>(null)

  React.useEffect(() => {
    if (!open) return
    setSelected(initialSelected)
    setCompilerModel(initialCompilerModel)
    setPhase(initialSummary ? 'summary' : modelMissing ? 'waiting_for_model' : 'select')
    setSummary(initialSummary)
    setPublishResult(null)
    setError(null)
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
  const prepare = async (visionChoice?: 'accept' | 'decline') => {
    setError(null)
    setProgress({ stage: 'plan' })
    setPhase('preparing')
    try {
      onSaveSelection(teamId, selected)
      onSaveCompilerModel?.(teamId, compilerModel)
      const next = visionChoice
        ? await onPrepare(teamId, selected, compilerModel, visionChoice)
        : await onPrepare(teamId, selected, compilerModel)
      setSummary(next)
      setProgress(null)
      setPhase(next.needsVisionAcceptance ? 'vision' : 'summary')
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
      const result = await onPublish(teamId, summary, true)
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
      setPhase(modelMissing ? 'waiting_for_model' : 'select')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const activeStage = progress?.stage ?? 'plan'
  const activeIndex = Math.max(0, STAGES.indexOf(activeStage as (typeof STAGES)[number]))

  return (
    <ModalShell
      title={t('teamShare.wikiMaintainTitle', 'Maintain Wiki')}
      hint={
        phase === 'vision'
          ? t(
              'teamShare.wikiVisionBeforeCompileHint',
              'Confirm the visual recognition cost, then compile. Nothing is compiled until you agree.',
            )
          : phase === 'summary' || phase === 'publishing' || phase === 'published'
          ? t(
              'teamShare.wikiMaintainSummaryHint',
              'Review the result, then confirm publish. Nothing is written to the knowledge base until you confirm.',
            )
          : t(
              'teamShare.wikiMaintainHint',
              'Choose source folders, then check and compile. Nothing is published until you confirm.',
            )
      }
      onClose={close}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={close} disabled={busy}>
            {phase === 'published' ? t('common.close', 'Close') : t('common.cancel', 'Cancel')}
          </Button>
          {(phase === 'select' || phase === 'waiting_for_model' || phase === 'preparing') && (
            <Button
              type="button"
              onClick={() => void prepare()}
              disabled={
                busy ||
                phase === 'waiting_for_model' ||
                selected.length === 0 ||
                !compilerModel ||
                !compilerModels.some((model) => model.id === compilerModel)
              }
            >
              {phase === 'preparing' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('teamShare.wikiCheckCompile', 'Check and compile')}
            </Button>
          )}
          {phase === 'vision' && (
            <>
              <Button type="button" variant="ghost" onClick={() => void prepare('decline')} disabled={busy}>
                {t('teamShare.wikiCompileWithoutVision', 'Compile text only')}
              </Button>
              <Button type="button" onClick={() => void prepare('accept')} disabled={busy}>
                {t('teamShare.wikiCompileWithVision', 'Agree and compile')}
              </Button>
            </>
          )}
          {(phase === 'summary' || phase === 'publishing') && (
            <Button
              type="button"
              onClick={() => void publish()}
              disabled={busy || !summary?.canPublish}
            >
              {phase === 'publishing' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('teamShare.wikiConfirmPublish', 'Confirm publish')}
            </Button>
          )}
        </>
      }
    >
      {(phase === 'select' || phase === 'waiting_for_model') && (
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
                if (!next) return
                setCompilerModel(next)
                onSaveCompilerModel?.(teamId, next)
                if (compilerModels.some((model) => model.id === next)) {
                  setPhase('select')
                }
              }}
              aria-label={t('teamShare.wikiCompilerModel', 'Compiler model')}
              disabled={compilerModels.length === 0}
            >
              {(compilerModels.length === 0 || phase === 'waiting_for_model') && (
                <option value="">
                  {compilerModels.length === 0
                    ? t('teamShare.wikiCompilerModelEmpty', 'No models available')
                    : t('teamShare.wikiChooseCompilerModel', 'Choose a compiler model')}
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
          {phase === 'waiting_for_model' && (
            <p className="mt-3 text-[12px] leading-relaxed text-foreground">
              {t(
                'teamShare.wikiWaitingForModel',
                'This computer does not have the model that compiled the remaining sources. Choose that model, or explicitly pick another model before continuing. A finished result can still be published.',
              )}
            </p>
          )}
          {needsAdopt && (
            <Button
              type="button"
              variant="ghost"
              className="mt-3 h-8 px-2 text-[12px]"
              onClick={() => {
                void onAdopt?.(teamId).catch((reason: unknown) => {
                  setError(reason instanceof Error ? reason.message : String(reason))
                })
              }}
            >
              {t('teamShare.wikiAdoptExisting', 'Adopt the published Wiki')}
            </Button>
          )}
          <p className="mt-3 text-[11.5px] leading-relaxed text-muted-foreground">
            {t(
              'teamShare.wikiSingleMaintainerWarning',
              'This version detects stale checkpoints but does not prevent two computers from starting. Start maintenance on one computer only.',
            )}
          </p>
        </div>
      )}

      {phase === 'vision' && summary && (
        <div className="space-y-3">
          <p className="text-[13px] leading-relaxed text-ink-2">
            {t(
              'teamShare.wikiVisionBeforeCompile',
              '{{pages}} pages need visual recognition, estimated {{cost}} {{currency}}. Agree to send them to the current model. If it cannot read images, those files fail and the rest still compile.',
              {
                pages: summary.visionPages,
                cost: summary.estimatedCost ?? '?',
                currency: summary.currency,
              },
            )}
          </p>
          {summary.blockers.length > 0 && <BlockerList blockers={summary.blockers} />}
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
          {summary.blockers.length > 0 && (
            <BlockerList blockers={summary.blockers} />
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

function displayBlocker(
  blocker: string,
  t: (key: string, fallback: string, vars?: Record<string, unknown>) => string,
) {
  const retractBlocked = 'A deleted source is still cited. Compile again before publishing.'
  if (blocker.includes(retractBlocked)) {
    return t('teamShare.wikiRetractBlocked', retractBlocked)
  }
  const visionSentences: Array<[string, string]> = [
    ['This run did not look at images.', 'teamShare.wikiVisionDeclined'],
    ['This model cannot read images.', 'teamShare.wikiVisionUnsupported'],
    ['The model refused to read this file.', 'teamShare.wikiVisionRefused'],
    ['No text was recognized in this file.', 'teamShare.wikiVisionEmpty'],
    ['This file could not be opened.', 'teamShare.wikiVisionUnreadable'],
    [
      'This file has too many visual pages. Split it, then compile again.',
      'teamShare.wikiVisionTooManyPages',
    ],
    [
      'The file was read, but the compiler did not write a Wiki page.',
      'teamShare.wikiVisionNoPage',
    ],
  ]
  for (const [sentence, key] of visionSentences) {
    if (!blocker.includes(sentence)) continue
    const translated = t(key, sentence)
    return blocker.split(sentence).join(translated)
  }
  const marker = 'Compiler model failed:'
  const at = blocker.indexOf(marker)
  if (at < 0) return blocker
  const detail = blocker.slice(at + marker.length).trim()
  const head = blocker.slice(0, at).replace(/:\s*$/, '')
  const message = t('teamShare.wikiCompilerModelFailed', 'Compiler model failed: {{detail}}', {
    detail,
  })
  return head ? `${head}: ${message}` : message
}

function SummaryItem({ text }: { text: string }) {
  return <div className="rounded-[8px] border border-border-soft bg-panel px-3 py-2">{text}</div>
}

function BlockerList({ blockers }: { blockers: string[] }) {
  const { t } = useTranslation()
  const grouped = groupBlockers(blockers)
  return (
    <div className="space-y-2">
      {grouped.noPages.length > 0 && (
        <SkippedNotice
          message={t(
            'teamShare.wikiCompilerWroteNothing',
            'The compiler finished without writing Wiki pages for {{count}} sources. Try another compiler model, then compile again.',
            { count: grouped.noPages.length },
          )}
          paths={grouped.noPages}
        />
      )}
      {grouped.skippedCount > 0 && (
        <SkippedNotice
          message={t(
            'teamShare.wikiSourcesSkipped',
            '{{count}} sources were skipped this run and can be compiled again next time.',
            { count: grouped.skippedCount },
          )}
          paths={grouped.skipped}
        />
      )}
      {grouped.rest.length > 0 && (
        <div className="rounded-[8px] border border-destructive/30 bg-destructive/5 p-3">
          {grouped.rest.map((blocker) => (
            <div key={blocker} className="flex gap-2 text-[12px] text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{displayBlocker(blocker, t)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SkippedNotice({ message, paths }: { message: string; paths: string[] }) {
  return (
    <div className="rounded-[8px] border border-border bg-panel p-3">
      <div className="flex gap-2 text-[12.5px] text-ink-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span>{message}</span>
      </div>
      {paths.length > 0 && (
        <ul className="mt-2 max-h-32 space-y-0.5 overflow-y-auto pl-5 font-mono text-[11px] text-faint">
          {paths.map((path) => (
            <li key={path} className="truncate">
              {path}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
