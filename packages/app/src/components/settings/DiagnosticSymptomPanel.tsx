import * as React from 'react'
import { CheckCircle2, AlertTriangle, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SettingsSection } from '@/stores/ui'
import type { DiagnosticFinding, FindingStatus, TraceEvent } from '@/lib/diagnostics/types'
import type { SendStripStage, SymptomTab } from '@/lib/diagnostics/view'
import type { RemediationId } from '@/lib/diagnostics/remediations'
import { remediationsForFinding } from '@/lib/diagnostics/remediations'
import {
  findingsForSymptom,
  primaryFinding,
  sendStageStrip,
  tracesForSession,
  tracesForSymptom,
} from '@/lib/diagnostics/view'

function statusIcon(status: FindingStatus | 'error' | 'idle') {
  if (status === 'ok') return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
  if (status === 'warn') return <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
  if (status === 'idle') return <span className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full bg-border" />
  return <XCircle className="h-4 w-4 shrink-0 text-destructive" />
}

function RemediationButtons({
  finding,
  onRemediate,
}: {
  finding: DiagnosticFinding
  onRemediate: (id: RemediationId) => void
}) {
  const actions = remediationsForFinding(finding)
  if (actions.length === 0) return null
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          onClick={() => onRemediate(action.id)}
          className={cn(
            'rounded-[7px] border px-2.5 py-1 text-[12px] font-medium',
            action.tone === 'danger'
              ? 'border-destructive/30 text-destructive hover:bg-destructive/5'
              : 'border-border-soft bg-paper text-foreground hover:bg-background',
          )}
        >
          {action.label}
        </button>
      ))}
    </div>
  )
}

function ConclusionCard({
  finding,
  onOpenHint,
  onRemediate,
}: {
  finding: DiagnosticFinding | null
  onOpenHint: (section: SettingsSection) => void
  onRemediate: (id: RemediationId) => void
}) {
  if (!finding) {
    return (
      <div className="rounded-[10px] border border-border-soft bg-panel px-3 py-2.5">
        <p className="text-[13px] text-muted-foreground">此症状暂无结论。先运行一次诊断。</p>
      </div>
    )
  }
  return (
    <div className="rounded-[10px] border border-border-soft bg-panel px-3 py-2.5">
      <div className="flex items-start gap-2">
        {statusIcon(finding.status)}
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-foreground">{finding.title}</p>
          <p className="mt-0.5 text-[12.5px] text-ink-2">{finding.message}</p>
          <p className="mt-1 font-mono text-[11px] text-faint">{finding.code}</p>
          <p className="mt-1 text-[12px] text-muted-foreground">{finding.nextAction}</p>
          {finding.hintSection && (
            <button
              type="button"
              onClick={() => onOpenHint(finding.hintSection!)}
              className="mt-1 text-[12px] text-coral hover:underline"
            >
              前往相关设置 →
            </button>
          )}
          <RemediationButtons finding={finding} onRemediate={onRemediate} />
        </div>
      </div>
    </div>
  )
}

function SendStrip({ stages }: { stages: SendStripStage[] }) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto py-1">
      {stages.map((stage, index) => (
        <React.Fragment key={stage.id}>
          {index > 0 && <span className="h-px w-4 shrink-0 bg-border-soft" />}
          <div className="flex items-center gap-1.5 rounded-[7px] border border-border-soft bg-background px-2 py-1">
            {statusIcon(stage.status === 'error' ? 'fail' : stage.status)}
            <span className="text-[11px] font-mono text-muted-foreground">{stage.label}</span>
          </div>
        </React.Fragment>
      ))}
    </div>
  )
}

function TraceList({ traces }: { traces: TraceEvent[] }) {
  if (traces.length === 0) {
    return <p className="text-[12px] text-muted-foreground">没有可展示的发送轨迹。</p>
  }
  return (
    <ol className="space-y-1.5">
      {traces.map((event, index) => (
        <li key={`${event.traceId}-${event.rawStage}-${index}`} className="flex items-start gap-2">
          {statusIcon(event.status === 'error' ? 'fail' : event.status === 'ok' ? 'ok' : 'warn')}
          <div className="min-w-0">
            <p className="font-mono text-[11px] text-foreground">{event.rawStage}</p>
            <p className="text-[11px] font-mono text-faint">
              {event.stage}
              {event.errorCode ? ` · ${event.errorCode}` : ''}
              {event.durationMs != null ? ` · ${event.durationMs}ms` : ''}
            </p>
          </div>
        </li>
      ))}
    </ol>
  )
}

function EvidenceList({ findings }: { findings: DiagnosticFinding[] }) {
  const evidence = findings.flatMap((item) =>
    item.evidence.map((entry) => ({ ...entry, code: item.code })),
  )
  if (evidence.length === 0) {
    return <p className="text-[12px] text-muted-foreground">没有额外证据。</p>
  }
  return (
    <ul className="space-y-1.5">
      {evidence.map((entry, index) => (
        <li key={`${entry.code}-${entry.summary}-${index}`} className="text-[12px] text-muted-foreground">
          <span className="font-mono text-[11px] text-faint">{entry.source}</span>
          {' · '}
          {entry.summary}
        </li>
      ))}
    </ul>
  )
}

export function DiagnosticSymptomPanel({
  tab,
  findings,
  traces,
  sessionId,
  onOpenHint,
  onRemediate,
}: {
  tab: SymptomTab
  findings: DiagnosticFinding[]
  traces: TraceEvent[]
  sessionId: string | null
  onOpenHint: (section: SettingsSection) => void
  onRemediate: (id: RemediationId) => void
}) {
  const scopedFindings = findingsForSymptom(findings, tab)
  const conclusion = primaryFinding(findings, tab)
  const scopedTraces = tracesForSymptom(
    sessionId ? tracesForSession(traces, sessionId) : traces,
    tab,
  )

  return (
    <div className="space-y-4">
      <ConclusionCard finding={conclusion} onOpenHint={onOpenHint} onRemediate={onRemediate} />
      {tab === 'send' && <SendStrip stages={sendStageStrip(scopedTraces)} />}
      {scopedFindings.length > 1 && (
        <div className="space-y-1">
          {scopedFindings
            .filter((item) => item.code !== conclusion?.code)
            .map((item) => (
              <div key={item.code} className="flex items-start gap-2 py-1">
                {statusIcon(item.status)}
                <p className="text-[12.5px] text-muted-foreground">
                  <span className="font-medium text-foreground">{item.title}</span>
                  {' · '}
                  {item.message}
                </p>
              </div>
            ))}
        </div>
      )}
      <div>
        <h5 className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.8px] text-faint">
          Timeline
        </h5>
        <TraceList traces={scopedTraces} />
      </div>
      <div>
        <h5 className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.8px] text-faint">
          证据
        </h5>
        <EvidenceList findings={scopedFindings} />
      </div>
    </div>
  )
}

export function AuthSyncBanner({
  findings,
  onRemediate,
}: {
  findings: DiagnosticFinding[]
  onRemediate: (id: RemediationId) => void
}) {
  const auth = findings.filter((item) => item.symptom === 'auth_sync' && item.status !== 'ok')
  if (auth.length === 0) return null
  return (
    <div className="space-y-2">
      {auth.map((item) => (
        <div
          key={item.code}
          className={cn(
            'flex items-start gap-2 rounded-[10px] border border-border-soft bg-panel px-3 py-2',
          )}
        >
          {statusIcon(item.status)}
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-foreground">{item.title}</p>
            <p className="text-[12px] text-muted-foreground">{item.message}</p>
            <RemediationButtons finding={item} onRemediate={onRemediate} />
          </div>
        </div>
      ))}
    </div>
  )
}
