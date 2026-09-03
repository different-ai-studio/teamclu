import { useEffect, useState, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { RefreshCw, AlertCircle, CheckCircle2 } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { getFeatures } from "@/lib/config/remote-features"
import { useUpdaterStore } from "@/stores/updater"
import { useShallow } from "zustand/react/shallow"

/**
 * Windows applies the update on restart, not before it.
 *
 * macOS swaps the bundle during the install step, so by the time this dialog
 * appears the new version is already on disk and a restart merely picks it up.
 * An NSIS installer cannot patch a running install, so on Windows the download
 * is only staged — the installer runs while the app is closed. Same dialog,
 * materially different promise, so the copy has to say which one it is.
 */
function isWindows(): boolean {
  // Three sources, because the first one is going away: `navigator.platform` is
  // a User-Agent-reduction target and a future WebView2 may freeze or empty it.
  // Getting this wrong is not cosmetic — an emptied value would fall through to
  // the macOS copy, and a Windows user told "the update has been installed"
  // clicks "Restart later" and loses the staged installer.
  const uaPlatform = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData?.platform
  // `startsWith`, not `includes`: platform strings are "Win32" / "Windows", and
  // a substring test matches "darwin" — which is how the first version of this
  // told every macOS user they were on Windows.
  const platforms = [uaPlatform, navigator.platform]
    .filter((p): p is string => !!p)
    .map((p) => p.toLowerCase())
  if (platforms.some((p) => p.startsWith('win'))) return true
  // The UA spells it out in full ("Windows NT 10.0"), so it needs no such care.
  return (navigator.userAgent ?? '').toLowerCase().includes('windows')
}

const releaseNotesMarkdownPlugins = [remarkGfm]

const releaseNotesMarkdownComponents = {
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="mb-1.5 mt-2 text-base font-semibold leading-6 text-foreground first:mt-0">{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="mb-1.5 mt-2 text-[15px] font-semibold leading-6 text-foreground first:mt-0">{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="mb-1.5 mt-2 text-sm font-semibold leading-5 text-foreground first:mt-0">{children}</h3>
  ),
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="my-1.5 leading-5 first:mt-0 last:mb-0">{children}</p>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="my-1.5 list-disc space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="my-1.5 list-decimal space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li className="pl-0.5 leading-5">{children}</li>
  ),
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>
  ),
  a: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
    <a className="text-foreground underline underline-offset-2" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  code: ({ className, children }: { className?: string; children?: React.ReactNode }) => {
    const isBlock = !!className
    if (isBlock) {
      return (
        <code className="block max-w-full whitespace-pre font-mono text-[12px] leading-5 text-foreground">
          {children}
        </code>
      )
    }

    return (
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.92em] leading-snug text-foreground break-words [overflow-wrap:anywhere]">
        {children}
      </code>
    )
  },
  pre: ({ children }: { children?: React.ReactNode }) => (
    <pre className="my-2 max-w-full overflow-x-auto rounded-md bg-muted px-3 py-2">{children}</pre>
  ),
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-2 overflow-x-auto rounded-md border border-border first:mt-0 last:mb-0">
      <table className="min-w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border-b border-border bg-muted px-2 py-1.5 text-left font-semibold text-foreground">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border-b border-border px-2 py-1.5 last:border-b-0">{children}</td>
  ),
} as const

export function UpdateDialogContainer() {
  const { t } = useTranslation()
  const { update, checkForUpdates, retryUpdate, restart } = useUpdaterStore(
    useShallow((s) => ({ update: s.update, checkForUpdates: s.checkForUpdates, retryUpdate: s.retryUpdate, restart: s.restart })),
  )
  const [dismissed, setDismissed] = useState(false)
  const [restarting, setRestarting] = useState(false)

  // Check for updates on app startup (3s delay) and every 4 hours
  useEffect(() => {
    if (
      !getFeatures().updater
      || import.meta.env.DEV
      || typeof window === "undefined"
      || !(window as unknown as { __TAURI__: unknown }).__TAURI__
    ) {
      return
    }

    const timer = setTimeout(() => {
      checkForUpdates(true)
    }, 3000)

    const interval = setInterval(() => {
      checkForUpdates(true)
    }, 4 * 60 * 60 * 1000)

    return () => {
      clearTimeout(timer)
      clearInterval(interval)
    }
  }, [checkForUpdates])

  // Reset dismissed state when a new check starts
  useEffect(() => {
    if (update.state === "checking") {
      setDismissed(false)
    }
  }, [update.state])

  const handleDismiss = useCallback(() => {
    setDismissed(true)
  }, [])

  const handleRestart = useCallback(() => {
    setRestarting(true)
    void restart()
  }, [restart])

  // A failed restart flips the store to `error`; let the user try again.
  useEffect(() => {
    if (update.state !== "ready") {
      setRestarting(false)
    }
  }, [update.state])

  // Updates download/install in the background; only prompt the user to restart (or report failure).
  const showDialog =
    !dismissed && (update.state === "ready" || update.state === "error")

  return (
    <Dialog open={showDialog} onOpenChange={() => handleDismiss()}>
      <DialogContent className="overflow-hidden sm:max-w-[425px]">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-muted text-primary">
              {update.state === "error" ? (
                <AlertCircle className="h-5 w-5 text-destructive" />
              ) : (
                <CheckCircle2 className="h-5 w-5 text-green-500" />
              )}
            </div>
            <DialogTitle className="text-lg">
              {update.state === "ready" && t('updater.ready', 'Update Ready')}
              {update.state === "error" && t('updater.failed', 'Update Failed')}
            </DialogTitle>
          </div>
          <DialogDescription asChild>
            {update.state === "ready" ? (
              <div className="text-left space-y-2 text-sm text-muted-foreground">
                <p>
                  {update.version && (
                    <span className="font-medium text-foreground">v{update.version}</span>
                  )}
                  {update.version && " — "}
                  {isWindows()
                    ? t('updater.restartToInstall', 'The update is downloaded. Restart to install it.')
                    : t('updater.restartToApply', 'The update has been installed. Restart to apply changes.')}
                </p>
                <p>
                  {isWindows()
                    ? t(
                        'updater.restartInstallerNote',
                        'The installer runs with the app closed and reopens it when it finishes; Windows may ask you to allow it. Quitting instead discards the download.',
                      )
                    : t(
                        'updater.restartRecommendation',
                        'The update is installed. We recommend restarting soon to use the new version.',
                      )}
                </p>
              </div>
            ) : (
              <p className="text-left text-sm text-muted-foreground">
                {t('updater.updateError', 'An error occurred during the update process.')}
              </p>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 py-4">
          {update.state === "ready" && update.notes && (
            <div className="max-h-48 min-w-0 overflow-x-hidden overflow-y-auto rounded-lg border bg-muted/50 p-3">
              <p className="text-xs font-medium text-muted-foreground mb-1">{t('updater.releaseNotes', 'Release Notes')}</p>
              <div className="min-w-0 max-w-full text-sm text-foreground break-words [overflow-wrap:anywhere]">
                <ReactMarkdown
                  remarkPlugins={releaseNotesMarkdownPlugins}
                  components={releaseNotesMarkdownComponents}
                >
                  {update.notes}
                </ReactMarkdown>
              </div>
            </div>
          )}

          {update.state === "error" && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3">
              <p className="text-sm text-destructive">{update.errorMessage}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          {update.state === "ready" && (
            <>
              <Button
                variant="outline"
                onClick={handleDismiss}
                disabled={restarting}
                className="w-full sm:w-auto"
              >
                {t('updater.restartLater', 'Restart later')}
              </Button>
              <Button onClick={handleRestart} disabled={restarting} className="w-full sm:w-auto">
                <RefreshCw className={`h-4 w-4 mr-2${restarting ? " animate-spin" : ""}`} />
                {restarting
                  ? t('updater.restarting', 'Restarting…')
                  : t('updater.restartNow', 'Restart Now')}
              </Button>
            </>
          )}

          {update.state === "error" && (
            <>
              <Button variant="outline" onClick={handleDismiss} className="w-full sm:w-auto">
                {t('common.close', 'Close')}
              </Button>
              <Button onClick={retryUpdate} className="w-full sm:w-auto">
                <RefreshCw className="h-4 w-4 mr-2" />
                {t('updater.retry', 'Retry')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
