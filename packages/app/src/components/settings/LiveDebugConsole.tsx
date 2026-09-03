import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { invoke } from '@tauri-apps/api/core'
import {
  Copy,
  Eraser,
  FolderOpen,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Search,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingCard } from './shared'
import {
  clearConsoleCapture,
  formatConsoleEntry,
  getConsoleEntries,
  subscribeConsoleCapture,
  type ConsoleLevel,
} from '@/lib/diagnostics/console-capture'
import {
  getRuntimeStateSnapshot,
  type RuntimeStateSnapshot,
} from '@/lib/agent/runtime-state-snapshot'

type LiveTab = 'console' | 'state' | 'disk'

interface LogTailsExpanded {
  app: string | null
  amuxdManaged: string | null
  amuxdOut: string | null
  amuxdErr: string | null
  acpStream: string | null
}

const LEVELS: Array<ConsoleLevel | 'all'> = ['all', 'debug', 'info', 'log', 'warn', 'error']
const DISK_POLL_MS = 2000
const DISK_TAIL_LINES = 200

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'px-3 py-1.5 text-[12.5px] rounded-md transition-colors',
        active
          ? 'bg-paper text-foreground border border-border'
          : 'text-muted-foreground hover:text-foreground',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

function StateRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-0.5 py-1.5 border-b border-border-soft last:border-0">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className="text-[12px] font-mono text-foreground break-all">{value}</span>
    </div>
  )
}

function flattenSnapshot(snapshot: RuntimeStateSnapshot): Array<{ label: string; value: string }> {
  return [
    { label: 'App version', value: snapshot.environment.version },
    { label: 'Build flavor', value: snapshot.environment.buildFlavor },
    { label: 'Platform', value: snapshot.environment.platform },
    { label: 'Tauri', value: String(snapshot.environment.tauri) },
    { label: 'Visibility', value: snapshot.environment.visibilityState },
    { label: 'Team', value: snapshot.team.name ?? snapshot.team.id ?? '—' },
    {
      label: 'MQTT connected',
      value:
        snapshot.mqtt.reconnect.connected == null
          ? 'unknown'
          : String(snapshot.mqtt.reconnect.connected),
    },
    { label: 'MQTT last error', value: snapshot.mqtt.reconnect.lastError ?? '—' },
    {
      label: 'MQTT bridge topics',
      value: String(snapshot.mqtt.bridge?.subscribedTopics?.length ?? 0),
    },
    {
      label: 'Daemon live SSE',
      value: snapshot.mqtt.daemonLiveConnected ? 'connected' : 'down',
    },
    { label: 'Auth user', value: snapshot.auth?.user?.email ?? snapshot.auth?.user?.id ?? '—' },
    {
      label: 'Token expiry',
      value:
        snapshot.auth?.accessToken &&
        typeof snapshot.auth.accessToken === 'object' &&
        snapshot.auth.accessToken !== null &&
        'expiresAt' in snapshot.auth.accessToken
          ? String(snapshot.auth.accessToken.expiresAt ?? '—')
          : '—',
    },
    { label: 'Current session', value: snapshot.session.currentSessionId ?? '—' },
    { label: 'Active session', value: snapshot.session.activeSessionId ?? '—' },
    {
      label: 'Daemon HTTP',
      value: snapshot.daemon
        ? snapshot.daemon.ok
          ? `ok (${snapshot.daemon.baseUrl})`
          : `fail (${snapshot.daemon.reason})`
        : '—',
    },
    { label: 'Startup marks', value: String(snapshot.startupTimeline.length) },
  ]
}

function DiskLogPanel({
  title,
  content,
  emptyLabel,
}: {
  title: string
  content: string | null
  emptyLabel: string
}) {
  return (
    <div className="space-y-1.5">
      <h5 className="text-[12px] font-semibold text-foreground">{title}</h5>
      <pre className="max-h-40 overflow-auto rounded-md border border-border-soft bg-background p-2 text-[11px] font-mono text-ink-2 whitespace-pre-wrap break-all">
        {content?.trim() ? content : emptyLabel}
      </pre>
    </div>
  )
}

export const LiveDebugConsole = React.memo(function LiveDebugConsole() {
  const { t } = useTranslation()
  const [tab, setTab] = React.useState<LiveTab>('console')
  const [level, setLevel] = React.useState<ConsoleLevel | 'all'>('all')
  const [search, setSearch] = React.useState('')
  const [paused, setPaused] = React.useState(false)
  const [tick, setTick] = React.useState(0)
  const [snapshot, setSnapshot] = React.useState<RuntimeStateSnapshot | null>(null)
  const [snapshotLoading, setSnapshotLoading] = React.useState(false)
  const [diskLogs, setDiskLogs] = React.useState<LogTailsExpanded | null>(null)
  const [diskLoading, setDiskLoading] = React.useState(false)
  const scrollRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    return subscribeConsoleCapture(() => {
      if (!paused) setTick((n) => n + 1)
    })
  }, [paused])

  const entries = React.useMemo(
    () =>
      getConsoleEntries({
        level,
        search,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick drives refresh
    [level, search, tick],
  )

  React.useEffect(() => {
    if (tab !== 'console' || paused || !scrollRef.current) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [entries.length, tab, paused])

  const refreshSnapshot = React.useCallback(async () => {
    setSnapshotLoading(true)
    try {
      const next = await getRuntimeStateSnapshot()
      setSnapshot(next)
    } catch (err) {
      toast.error(
        t('settings.diagnostics.liveConsole.stateRefreshFailed', '刷新状态失败：{{message}}', {
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    } finally {
      setSnapshotLoading(false)
    }
  }, [t])

  React.useEffect(() => {
    if (tab === 'state' && !snapshot && !snapshotLoading) {
      void refreshSnapshot()
    }
  }, [tab, snapshot, snapshotLoading, refreshSnapshot])

  const refreshDiskLogs = React.useCallback(async () => {
    setDiskLoading(true)
    try {
      const tails = await invoke<LogTailsExpanded>('tail_log_files', {
        maxLines: DISK_TAIL_LINES,
      })
      setDiskLogs(tails)
    } catch (err) {
      toast.error(
        t('settings.diagnostics.liveConsole.diskRefreshFailed', '读取磁盘日志失败：{{message}}', {
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    } finally {
      setDiskLoading(false)
    }
  }, [t])

  React.useEffect(() => {
    if (tab !== 'disk') return
    void refreshDiskLogs()
    const id = window.setInterval(() => {
      void refreshDiskLogs()
    }, DISK_POLL_MS)
    return () => window.clearInterval(id)
  }, [tab, refreshDiskLogs])

  const handleCopyConsole = async () => {
    const text = entries.map(formatConsoleEntry).join('\n')
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      toast.error(t('settings.diagnostics.copyFailed', '复制失败'))
    }
  }

  const handleCopySnapshot = async () => {
    if (!snapshot) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2))
    } catch {
      toast.error(t('settings.diagnostics.copyFailed', '复制失败'))
    }
  }

  const revealLogDir = async (kind: 'app' | 'daemon' | 'acp') => {
    try {
      await invoke('reveal_log_directory', { kind })
    } catch (err) {
      toast.error(
        t('settings.diagnostics.liveConsole.revealFailed', '打开目录失败：{{message}}', {
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  }

  const stateRows = snapshot ? flattenSnapshot(snapshot) : []

  return (
    <SettingCard>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h4 className="text-[13px] font-semibold">
            {t('settings.diagnostics.liveConsole.title', '实时调试台')}
          </h4>
          <p className="text-[12px] text-muted-foreground mt-0.5">
            {t(
              'settings.diagnostics.liveConsole.description',
              '查看 Console 输出、运行状态与磁盘日志，无需 Web Inspector。',
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <TabButton active={tab === 'console'} onClick={() => setTab('console')}>
            {t('settings.diagnostics.liveConsole.tabConsole', 'Console')}
          </TabButton>
          <TabButton active={tab === 'state'} onClick={() => setTab('state')}>
            {t('settings.diagnostics.liveConsole.tabState', '运行状态')}
          </TabButton>
          <TabButton active={tab === 'disk'} onClick={() => setTab('disk')}>
            {t('settings.diagnostics.liveConsole.tabDisk', '磁盘日志')}
          </TabButton>
        </div>
      </div>

      {tab === 'console' && (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="flex flex-wrap gap-1">
              {LEVELS.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setLevel(item)}
                  className={[
                    'px-2 py-0.5 text-[11px] font-mono rounded',
                    level === item ? 'bg-selected text-foreground' : 'text-faint hover:text-foreground',
                  ].join(' ')}
                >
                  {item}
                </button>
              ))}
            </div>
            <div className="relative flex-1 min-w-[140px]">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('settings.diagnostics.liveConsole.search', '搜索…')}
                className="w-full rounded-md border border-border-soft bg-background py-1 pl-7 pr-2 text-[12px] outline-none focus:border-border"
              />
            </div>
            <Button variant="outline" size="sm" onClick={() => setPaused((p) => !p)} className="gap-1.5 h-7">
              {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
              {paused
                ? t('settings.diagnostics.liveConsole.resume', '继续')
                : t('settings.diagnostics.liveConsole.pause', '暂停')}
            </Button>
            <Button variant="outline" size="sm" onClick={handleCopyConsole} className="gap-1.5 h-7">
              <Copy className="h-3.5 w-3.5" />
              {t('settings.diagnostics.liveConsole.copy', '复制')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                clearConsoleCapture()
                setTick((n) => n + 1)
              }}
              className="gap-1.5 h-7"
            >
              <Eraser className="h-3.5 w-3.5" />
              {t('settings.diagnostics.liveConsole.clear', '清空')}
            </Button>
          </div>
          <div
            ref={scrollRef}
            className="max-h-72 overflow-auto rounded-md border border-border-soft bg-background p-2 font-mono text-[11px] text-ink-2"
          >
            {entries.length === 0 ? (
              <p className="text-faint">
                {t('settings.diagnostics.liveConsole.consoleEmpty', '暂无 Console 输出')}
              </p>
            ) : (
              entries.map((entry, index) => (
                <div key={`${entry.ts}-${index}`} className="whitespace-pre-wrap break-all py-0.5">
                  {formatConsoleEntry(entry)}
                </div>
              ))
            )}
          </div>
        </>
      )}

      {tab === 'state' && (
        <>
          <div className="flex flex-wrap gap-2 mb-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refreshSnapshot()}
              disabled={snapshotLoading}
              className="gap-1.5 h-7"
            >
              {snapshotLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {t('settings.diagnostics.liveConsole.refreshState', '刷新快照')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleCopySnapshot()}
              disabled={!snapshot}
              className="gap-1.5 h-7"
            >
              <Copy className="h-3.5 w-3.5" />
              {t('settings.diagnostics.liveConsole.copyJson', '复制 JSON')}
            </Button>
          </div>
          <div className="rounded-md border border-border-soft bg-background p-2">
            {snapshotLoading && !snapshot ? (
              <div className="flex items-center gap-2 text-[12px] text-muted-foreground py-4">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('settings.diagnostics.liveConsole.loadingState', '正在收集状态…')}
              </div>
            ) : (
              stateRows.map((row) => <StateRow key={row.label} label={row.label} value={row.value} />)
            )}
          </div>
        </>
      )}

      {tab === 'disk' && (
        <>
          <div className="flex flex-wrap gap-2 mb-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refreshDiskLogs()}
              disabled={diskLoading}
              className="gap-1.5 h-7"
            >
              {diskLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {t('settings.diagnostics.liveConsole.refreshDisk', '刷新日志')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void revealLogDir('app')} className="gap-1.5 h-7">
              <FolderOpen className="h-3.5 w-3.5" />
              {t('settings.diagnostics.liveConsole.openAppLogs', '桌面应用日志')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void revealLogDir('daemon')} className="gap-1.5 h-7">
              <FolderOpen className="h-3.5 w-3.5" />
              {t('settings.diagnostics.liveConsole.openDaemonLogs', 'Daemon 日志')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void revealLogDir('acp')} className="gap-1.5 h-7">
              <FolderOpen className="h-3.5 w-3.5" />
              {t('settings.diagnostics.liveConsole.openAcpLogs', 'ACP 日志')}
            </Button>
          </div>
          <div className="space-y-4">
            <DiskLogPanel
              title={t('settings.diagnostics.liveConsole.appLog', '桌面应用')}
              content={diskLogs?.app ?? null}
              emptyLabel={t('settings.diagnostics.liveConsole.noLog', '暂无日志或文件不存在')}
            />
            <DiskLogPanel
              title={t('settings.diagnostics.liveConsole.daemonManagedLog', 'Daemon (managed)')}
              content={diskLogs?.amuxdManaged ?? null}
              emptyLabel={t('settings.diagnostics.liveConsole.noLog', '暂无日志或文件不存在')}
            />
            <DiskLogPanel
              title={t('settings.diagnostics.liveConsole.daemonOutLog', 'Daemon stdout (legacy)')}
              content={diskLogs?.amuxdOut ?? null}
              emptyLabel={t('settings.diagnostics.liveConsole.noLog', '暂无日志或文件不存在')}
            />
            <DiskLogPanel
              title={t('settings.diagnostics.liveConsole.daemonErrLog', 'Daemon stderr (legacy)')}
              content={diskLogs?.amuxdErr ?? null}
              emptyLabel={t('settings.diagnostics.liveConsole.noLog', '暂无日志或文件不存在')}
            />
            <DiskLogPanel
              title={t('settings.diagnostics.liveConsole.acpLog', 'ACP stream')}
              content={diskLogs?.acpStream ?? null}
              emptyLabel={t('settings.diagnostics.liveConsole.noLog', '暂无日志或文件不存在')}
            />
          </div>
        </>
      )}
    </SettingCard>
  )
})
