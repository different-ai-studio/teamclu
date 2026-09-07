import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AppWindow } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/stores/ui'
import { useAppsStore } from '@/stores/apps-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { NAV_ROW_TRAILING_SLOT } from '@/components/sidebar/nav-row'

/**
 * One nav row, nothing more — the app list lives in column two now.
 *
 * It used to unfold a list of apps inside the rail, which put a scrolling list
 * inside a column that is otherwise fixed rows, and then made column two mean
 * two different things depending on whether a row in that list was selected.
 * Column two owns both levels now (list, then that app's sessions), so this row
 * only has to say "apps live here" and how many are on this machine.
 */
export function AppsNavSection() {
  const { t } = useTranslation()
  const filter = useUIStore((s) => s.sidebarFilter)
  const setFilter = useUIStore((s) => s.setSidebarFilter)
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? '')
  const allItems = useAppsStore((s) => s.items)
  const localAppIds = useAppsStore((s) => s.localAppIds)
  const load = useAppsStore((s) => s.load)
  const refreshLocalApps = useAppsStore((s) => s.refreshLocalApps)
  const selectApp = useAppsStore((s) => s.selectApp)

  const active = filter.kind === 'apps'

  // Loaded from the rail, not from column two: the count on this row has to be
  // right before anyone opens the column, and this component is always mounted.
  React.useEffect(() => {
    if (!teamId) return
    void load(teamId)
    void refreshLocalApps(teamId)
  }, [teamId, load, refreshLocalApps])

  /**
   * Only what is actually on this machine — the same set column two lists.
   *
   * `localAppIds === null` means the daemon has not answered yet, which is not
   * the same as "nothing is local": counting zero then would tell the user
   * their apps are gone every time the daemon is slow to start.
   */
  const count = React.useMemo(() => {
    if (localAppIds === null) return allItems.length
    const local = new Set(localAppIds)
    return allItems.filter((app) => local.has(app.id)).length
  }, [allItems, localAppIds])

  const openApps = React.useCallback(() => {
    // Always lands on the list. The row is the entrance to the section, and
    // column two's own back button is what returns from an app to the list —
    // if this row kept the last selection there would be no way in to the list
    // from here at all.
    selectApp(null)
    setFilter({ kind: 'apps' })
  }, [selectApp, setFilter])

  return (
    <button
      type="button"
      onClick={openApps}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-[9px] py-[7px] text-left text-[13px] transition-[background-color,box-shadow,color] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)]',
        active
          ? 'bg-paper font-semibold text-foreground shadow-[0_1px_2px_rgba(28,27,25,0.04)] ring-1 ring-black/[0.05]'
          : 'font-normal text-ink-2 hover:bg-black/[0.04]',
      )}
    >
      <AppWindow
        className={cn('h-[15px] w-[15px] shrink-0', active ? 'text-foreground' : 'text-muted-foreground')}
      />
      <span className="min-w-0 flex-1 truncate">{t('sidebar.apps', '应用')}</span>
      <span
        className={cn(
          NAV_ROW_TRAILING_SLOT,
          'text-[10.5px] font-semibold tabular-nums',
          active
            ? 'bg-coral text-coral-foreground shadow-[0_2px_6px_rgba(232,90,74,0.28)]'
            : 'text-muted-foreground',
        )}
      >
        {count}
      </span>
    </button>
  )
}
