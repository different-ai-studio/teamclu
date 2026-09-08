import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, RotateCcw, ScrollText, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { getBackend } from '@/lib/backend'
import { useAppsStore } from '@/stores/apps-store'
import type { AppLogEntry, AppLogsResult } from '@/lib/backend/types'

interface AppLogsTabContentProps {
  appId: string
}

type Kind = 'app' | 'request' | 'all'

/** Windows worth offering. Anything longer is a search, not a look. */
const WINDOWS = [15, 60, 6 * 60, 24 * 60, 7 * 24 * 60] as const

function windowLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  if (minutes < 24 * 60) return `${minutes / 60}h`
  return `${minutes / (24 * 60)}d`
}

/** Wall-clock only: every entry in view is from the same window, so the date
 *  would be the same string repeated down the whole column. */
function clock(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '--:--:--'
  return d.toLocaleTimeString(undefined, { hour12: false })
}

const LEVEL_CLASS: Record<AppLogEntry['level'], string> = {
  error: 'text-destructive',
  warn: 'text-amber-600 dark:text-amber-400',
  info: 'text-ink-2',
}

/**
 * The deployed app's own logs, in a main-column tab.
 *
 * Read-only and deliberately plain: the value is in the text and in being able
 * to pull one request out of it, not in a chart. The request-id chip is the
 * point — an app's own output has no request id of its own, so the server
 * reconstructs it from Function Compute's framing, and this is what makes that
 * reachable: click it and the view narrows to that one request.
 */
export function AppLogsTabContent({ appId }: AppLogsTabContentProps) {
  const { t } = useTranslation()
  const app = useAppsStore((s) => s.items.find((a) => a.id === appId) ?? null)

  const [kind, setKind] = React.useState<Kind>('app')
  const [sinceMinutes, setSinceMinutes] = React.useState<number>(60)
  const [search, setSearch] = React.useState('')
  const [contains, setContains] = React.useState('')
  const [requestId, setRequestId] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<AppLogsResult | null | 'loading'>('loading')
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    setResult('loading')
    setError(null)
    try {
      setResult(
        await getBackend().apps.readAppLogs(appId, {
          kind,
          sinceMinutes,
          limit: 200,
          contains: contains || null,
          requestId,
        }),
      )
    } catch (e) {
      setResult(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [appId, kind, sinceMinutes, contains, requestId])

  React.useEffect(() => {
    void load()
  }, [load])

  const entries = result && result !== 'loading' && result.status === 'ok' ? result.entries : []

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="shrink-0 border-b border-border-soft px-4 py-3">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
          <ScrollText className="h-4 w-4" />
          {t('apps.logs.title', '运行日志')}
        </h2>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          {t('apps.logs.subtitle', '{{name}} 线上运行时打印的内容。', {
            name: app?.name ?? appId,
          })}
        </p>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-soft px-3 py-2">
        <div className="flex items-center gap-0.5 rounded-[7px] bg-paper p-0.5">
          {(['app', 'request', 'all'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              data-testid={`app-logs-kind-${k}`}
              className={cn(
                'rounded-[5px] px-2 py-0.5 text-[11.5px]',
                kind === k
                  ? 'bg-background font-medium text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {k === 'app'
                ? t('apps.logs.kindApp', '应用输出')
                : k === 'request'
                  ? t('apps.logs.kindRequest', '请求')
                  : t('apps.logs.kindAll', '全部')}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-0.5 rounded-[7px] bg-paper p-0.5">
          {WINDOWS.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setSinceMinutes(m)}
              data-testid={`app-logs-window-${m}`}
              className={cn(
                'rounded-[5px] px-2 py-0.5 font-mono text-[11.5px]',
                sinceMinutes === m
                  ? 'bg-background font-medium text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {windowLabel(m)}
            </button>
          ))}
        </div>

        <form
          className="flex min-w-0 flex-1 items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            setContains(search.trim())
          }}
        >
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('apps.logs.searchPlaceholder', '搜索日志内容，回车确认')}
            className="h-7 min-w-[140px] flex-1 rounded-[7px] text-[12px]"
            data-testid="app-logs-search"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 shrink-0 gap-1 rounded-[7px] text-[12px]"
            disabled={result === 'loading'}
            onClick={() => void load()}
            data-testid="app-logs-refresh"
          >
            <RotateCcw className="h-3 w-3" />
            {t('common.refresh', '刷新')}
          </Button>
        </form>
      </div>

      {requestId && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border-soft bg-paper px-3 py-1.5">
          <span className="text-[11.5px] text-muted-foreground">
            {t('apps.logs.filteredByRequest', '只看这一次请求')}
          </span>
          <code className="truncate font-mono text-[11px] text-ink-2">{requestId}</code>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 gap-1 rounded-[6px] px-1.5 text-[11px]"
            onClick={() => setRequestId(null)}
            data-testid="app-logs-clear-request"
          >
            <X className="h-3 w-3" />
            {t('apps.logs.clearRequest', '清除')}
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        <LogsBody
          result={result}
          error={error}
          entries={entries}
          onPickRequest={setRequestId}
        />
      </div>
    </div>
  )
}

function LogsBody({
  result,
  error,
  entries,
  onPickRequest,
}: {
  result: AppLogsResult | null | 'loading'
  error: string | null
  entries: AppLogEntry[]
  onPickRequest: (requestId: string) => void
}) {
  const { t } = useTranslation()

  if (result === 'loading') {
    return (
      <div className="flex items-center gap-2 p-4 text-[12.5px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('common.loading', 'Loading…')}
      </div>
    )
  }

  if (error) {
    return (
      <p className="p-4 text-[12.5px] text-destructive" data-testid="app-logs-error">
        {error}
      </p>
    )
  }

  // Null is a 404: the app is gone, or this member may not read its logs. Both
  // are "there is nothing here for you", and neither should read as a bug.
  if (result === null) {
    return (
      <p className="p-4 text-[12.5px] text-muted-foreground" data-testid="app-logs-state-none">
        {t('apps.logs.notFound', '看不到这个应用的日志。')}
      </p>
    )
  }

  if (result.status === 'not_deployed') {
    return (
      <p className="p-4 text-[12.5px] text-muted-foreground" data-testid="app-logs-state-not-deployed">
        {t('apps.logs.notDeployed', '这个应用还没有部署过，部署之后才会有日志。')}
      </p>
    )
  }

  if (result.status === 'unavailable') {
    return (
      <p className="p-4 text-[12.5px] text-muted-foreground" data-testid="app-logs-state-unavailable">
        {t('apps.logs.unavailable', '暂时读不到日志：{{reason}}', { reason: result.reason })}
      </p>
    )
  }

  if (entries.length === 0) {
    return (
      <p className="p-4 text-[12.5px] text-muted-foreground" data-testid="app-logs-empty">
        {/* Deliberately about the window, not about the app: "no logs" reads as
            "logging is broken", and the usual cause is a quiet ten minutes. */}
        {t('apps.logs.empty', '这段时间里没有日志。换个时间范围，或者去访问一下应用再看。')}
      </p>
    )
  }

  return (
    <>
      {result.truncated && (
        <p
          className="border-b border-border-soft px-3 py-1.5 text-[11.5px] text-faint"
          data-testid="app-logs-truncated"
        >
          {t('apps.logs.truncated', '结果被截断了，只显示最近的一部分。缩短时间范围可以看得更全。')}
        </p>
      )}
      <ol className="divide-y divide-border-soft/60">
        {entries.map((entry, i) => (
          <li
            key={`${entry.ts}-${i}`}
            className="flex items-start gap-2 px-3 py-1 hover:bg-paper/60"
            data-testid="app-logs-entry"
          >
            <time className="shrink-0 pt-px font-mono text-[11px] text-faint">
              {clock(entry.ts)}
            </time>
            {entry.kind === 'request' && (
              <span
                className={cn(
                  'shrink-0 rounded-[4px] bg-paper px-1 py-px font-mono text-[10.5px]',
                  LEVEL_CLASS[entry.level],
                )}
              >
                {entry.statusCode ?? '—'}
              </span>
            )}
            <span
              className={cn(
                'min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[11.5px]',
                LEVEL_CLASS[entry.level],
              )}
            >
              {entry.message}
            </span>
            {entry.requestId && (
              <button
                type="button"
                onClick={() => onPickRequest(entry.requestId!)}
                title={entry.requestId}
                data-testid="app-logs-request-chip"
                className="shrink-0 rounded-[4px] px-1 font-mono text-[10.5px] text-faint hover:bg-paper hover:text-ink-2"
              >
                {entry.requestId.slice(-8)}
              </button>
            )}
          </li>
        ))}
      </ol>
    </>
  )
}
