import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAppsStore } from '@/stores/apps-store'
import type { AppRow } from '@/lib/backend/types'

interface AppTabShellProps {
  appId: string
  title: string
  /** One line under the title saying what this surface decides. */
  description?: string
  /** Rendered to the right of the title — a create button, usually. */
  actions?: React.ReactNode
  children: (app: AppRow) => React.ReactNode
}

/**
 * The frame every app management tab shares: resolve the app, or say it is gone.
 *
 * Four tabs open from the control panel and all four are addressed by app id
 * alone, so all four need the same three things — the row out of the store, a
 * heading naming which app is being changed, and a single width the content
 * sits in. Repeating that four times is how three of them end up with a
 * different max-width and the fourth forgets to handle a deleted app.
 *
 * The app comes from the store rather than a fetch: the panel that opened this
 * tab is reading the same row, and a tab that re-fetched would show a stale
 * name for as long as it took to load.
 */
export function AppTabShell({
  appId,
  title,
  description,
  actions,
  children,
}: AppTabShellProps) {
  const { t } = useTranslation()
  const app = useAppsStore((s) => s.items.find((a) => a.id === appId) ?? null)

  if (!app) {
    return (
      <p className="p-6 text-[13px] text-muted-foreground">
        {t('apps.tab.appNotFound', '找不到这个应用 —— 它可能已经被删除了。')}
      </p>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="shrink-0 border-b border-border-soft px-6 py-4">
        <div className="mx-auto flex w-full max-w-[880px] items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-[15px] font-semibold text-foreground">
              {title}
            </h1>
            <p className="mt-0.5 truncate text-[12px] text-faint">{app.name}</p>
            {description ? (
              <p className="mt-2 max-w-[60ch] text-[12.5px] text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
          {actions ? <div className="shrink-0">{actions}</div> : null}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div className="mx-auto w-full max-w-[880px]">{children(app)}</div>
      </div>
    </div>
  )
}
