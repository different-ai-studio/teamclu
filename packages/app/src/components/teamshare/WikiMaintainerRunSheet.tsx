import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ModalShell } from '@/components/teamshare/skill-detail/ModalShell'

export interface WikiSourceDirectory {
  path: string
  label: string
}

export interface WikiPrepareSummary {
  runId: string
  sourceCount: number
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

type Phase = 'select' | 'preparing' | 'summary' | 'publishing' | 'published'

export function WikiMaintainerRunSheet({
  open,
  teamId,
  sourceDirectories,
  initialSelected,
  onSaveSelection,
  onPrepare,
  onPublish,
  onCancel,
  onClose,
}: {
  open: boolean
  teamId: string
  sourceDirectories: WikiSourceDirectory[]
  initialSelected: string[]
  onSaveSelection: (teamId: string, paths: string[]) => void
  onPrepare: (teamId: string, paths: string[]) => Promise<WikiPrepareSummary>
  onPublish: (runId: string, acceptVisionCost: boolean) => Promise<WikiPublishResult>
  onCancel?: (runId: string) => Promise<void>
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [selected, setSelected] = React.useState<string[]>(initialSelected)
  const [phase, setPhase] = React.useState<Phase>('select')
  const [summary, setSummary] = React.useState<WikiPrepareSummary | null>(null)
  const [publishResult, setPublishResult] = React.useState<WikiPublishResult | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [costAccepted, setCostAccepted] = React.useState(false)
  const autoStarted = React.useRef(false)

  React.useEffect(() => {
    if (!open) return
    autoStarted.current = false
    setSelected(initialSelected)
    setPhase('select')
    setSummary(null)
    setPublishResult(null)
    setError(null)
    setCostAccepted(false)
    // A successful first run persists a new array while this sheet is open.
    // Reinitializing on that array change would recursively start another run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const busy = phase === 'preparing' || phase === 'publishing'
  const togglePath = (path: string) => {
    setSelected((current) =>
      current.includes(path) ? current.filter((item) => item !== path) : [...current, path],
    )
  }
  const prepare = async () => {
    setError(null)
    setPhase('preparing')
    try {
      onSaveSelection(teamId, selected)
      const next = await onPrepare(teamId, selected)
      setSummary(next)
      setPhase('summary')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setPhase('select')
    }
  }
  React.useEffect(() => {
    if (!open || initialSelected.length === 0 || autoStarted.current) return
    autoStarted.current = true
    void prepare()
    // `initialSelected` is a persisted array and intentionally starts one run
    // when the sheet opens; phase changes must not start it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

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

  return (
    <ModalShell
      title={t('teamShare.wikiMaintainTitle', 'Maintain Wiki')}
      hint={t(
        'teamShare.wikiMaintainHint',
        'Choose source folders once. TeamClu checks, compiles, and shows a summary before anything is published.',
      )}
      onClose={close}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={close} disabled={busy}>
            {phase === 'published' ? t('common.close', 'Close') : t('common.cancel', 'Cancel')}
          </Button>
          {(phase === 'select' || phase === 'preparing') && (
            <Button type="button" onClick={() => void prepare()} disabled={busy || selected.length === 0}>
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
      {(phase === 'select' || phase === 'preparing') && (
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
          <p className="mt-3 text-[11.5px] leading-relaxed text-muted-foreground">
            {t(
              'teamShare.wikiSingleMaintainerWarning',
              'Do not maintain this Wiki from another computer at the same time.',
            )}
          </p>
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
