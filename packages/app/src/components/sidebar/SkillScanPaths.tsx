import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { FolderSearch } from 'lucide-react'
import { homeDir } from '@tauri-apps/api/path'
import { getSkillDirectories } from '@/lib/skills/loader'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * How many roots the pinned footer shows before the rest move into the
 * tooltip. Three fits under the list without eating the list.
 */
const VISIBLE_ROOTS = 3

function trimTrailingSlash(path: string): string {
  return path.replace(/[/\\]+$/, '')
}

/**
 * Display form of a scan root: `~` for the user's home, workspace-relative for
 * anything inside the open workspace, absolute otherwise.
 *
 * Same spelling the diagnostics report uses (`skill-diagnostics`'
 * `DIRECTORY_LABELS`), so a path read here and a path read there are
 * recognisably the same directory.
 */
export function shortenScanPath(
  dir: string,
  opts: { home?: string | null; workspacePath?: string | null } = {},
): string {
  const home = opts.home ? trimTrailingSlash(opts.home) : ''
  const workspace = opts.workspacePath ? trimTrailingSlash(opts.workspacePath) : ''
  if (workspace && dir.startsWith(`${workspace}/`)) return dir.slice(workspace.length + 1)
  if (home && dir.startsWith(`${home}/`)) return `~/${dir.slice(home.length + 1)}`
  return dir
}

/**
 * The skills column's footer: which directories this machine scans for skills.
 *
 * Answers the question the list itself cannot — "where did these come from, and
 * where do I put a new one" — without sending anyone to Diagnostics. Order is
 * the daemon's resolution order (`skill_dir_specs`), highest precedence first,
 * which is also what decides the winner when two roots hold the same slug.
 *
 * Local roots only: the caller renders this exclusively for the Agent that IS
 * this device, because a remote Agent's skills sit on a disk these paths say
 * nothing about.
 */
export function SkillScanPaths({
  workspacePath,
  refreshKey = 0,
}: {
  workspacePath: string | null
  refreshKey?: number
}) {
  const { t } = useTranslation()
  const [dirs, setDirs] = React.useState<string[]>([])
  const [home, setHome] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [roots, userHome] = await Promise.all([
          getSkillDirectories(workspacePath),
          homeDir(),
        ])
        if (cancelled) return
        setDirs(roots)
        setHome(userHome)
      } catch {
        // Browser mode, or the fs plugin said no. A footer that cannot name the
        // roots has nothing to say, so it says nothing.
        if (!cancelled) setDirs([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspacePath, refreshKey])

  if (dirs.length === 0) return null

  const visible = dirs.slice(0, VISIBLE_ROOTS)
  const hidden = dirs.length - visible.length

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="shrink-0 cursor-default border-t border-border bg-panel/60 px-3 py-2"
          data-testid="skill-scan-paths"
        >
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
            <FolderSearch className="h-3 w-3 shrink-0" />
            <span className="truncate">{t('teamShare.skillScanPaths', '扫描目录')}</span>
            <span className="font-mono tracking-normal">· {dirs.length}</span>
            {hidden > 0 && (
              <span className="ml-auto shrink-0 rounded bg-muted px-1 font-mono text-[10px] tracking-normal text-muted-foreground">
                +{hidden}
              </span>
            )}
          </div>
          <ul className="mt-1 space-y-px">
            {visible.map((dir) => (
              <li
                key={dir}
                className="truncate font-mono text-[10.5px] leading-[1.5] text-muted-foreground"
              >
                {shortenScanPath(dir, { home, workspacePath })}
              </li>
            ))}
          </ul>
        </div>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        sideOffset={6}
        className="max-w-[min(30rem,80vw)] [text-wrap:initial]"
      >
        <div className="mb-1 text-[11px] font-semibold">
          {t('teamShare.skillScanPathsHint', 'Skills 从这些目录加载，优先级从高到低')}
        </div>
        <ol className="space-y-0.5">
          {dirs.map((dir, index) => (
            <li key={dir} className="flex gap-2 font-mono text-[11px] leading-[1.45]">
              <span className="shrink-0 tabular-nums opacity-60">{index + 1}</span>
              <span className="break-all">{dir}</span>
            </li>
          ))}
        </ol>
      </TooltipContent>
    </Tooltip>
  )
}
