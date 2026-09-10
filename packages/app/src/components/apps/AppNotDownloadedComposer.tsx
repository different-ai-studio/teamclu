import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Loader2 } from 'lucide-react'
import { useAppsStore } from '@/stores/apps-store'
import type { AppRow } from '@/lib/backend/types'

/**
 * What stands in for the composer when the session's app is not on this
 * machine.
 *
 * The transcript above stays readable — messages are cloud rows and follow the
 * account onto every machine — but there is nothing here for an agent to work
 * in, so sending would either start a runtime in a directory that does not
 * exist or queue a message no local agent can answer. The bar says which app is
 * missing and offers the one action that fixes it; the real composer comes back
 * on its own the moment the checkout lands, because `localAppIds` is what
 * decides which of the two renders.
 */
export function AppNotDownloadedComposer({ app }: { app: AppRow }) {
  const { t } = useTranslation()
  const download = useAppsStore((s) => s.download)
  const [busy, setBusy] = React.useState(false)

  const handleDownload = React.useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      // Surfaces its own reason on failure (no repo to fetch, daemon down, no
      // access to the forge), so there is nothing to report here.
      await download(app)
    } finally {
      setBusy(false)
    }
  }, [app, busy, download])

  return (
    <div
      data-testid="app-not-downloaded-composer"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border-soft bg-paper px-4 py-3 text-[12.5px] text-muted-foreground"
    >
      <span className="min-w-0 flex-1">
        {t('apps.sessionNotDownloaded', {
          defaultValue: '「{{name}}」还没下载到本机，可以看历史，但不能在这里继续对话。',
          name: app.name,
        })}
      </span>
      <button
        type="button"
        onClick={() => void handleDownload()}
        disabled={busy}
        className="flex shrink-0 items-center gap-1.5 rounded-[8px] bg-coral px-3 py-1.5 text-[12.5px] font-semibold text-white transition-colors hover:bg-coral/90 disabled:opacity-40"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Download className="h-3.5 w-3.5" />
        )}
        {t('apps.libraryDownload', '下载')}
      </button>
    </div>
  )
}
