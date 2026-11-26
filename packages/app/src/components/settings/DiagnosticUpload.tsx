import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Loader2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { isTauri } from '@/lib/utils'
import type { DiagnosticReport } from '@/lib/diagnostics/diagnostic-report'
import { uploadDiagnosticZip, type DiagnosticReceipt } from '@/lib/diagnostics/diagnostic-upload'

/**
 * A deployment that has no private diagnostics bucket answers every upload with
 * 503 `diagnostics_unavailable` (services/fc diagnostic-storage.ts). That is
 * not a failure the user can retry their way out of, so after the first one the
 * button goes away for the rest of the run and a quiet note points at local
 * export instead of a red error.
 */
let uploadsUnavailable = false

/** Test seam: the flag is per-process, and tests share one. */
export function resetDiagnosticUploadAvailabilityForTest() {
  uploadsUnavailable = false
}

function isUnavailable(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'diagnostics_unavailable'
  )
}

/**
 * The upload button, rendered first in the export card's action row (`children`
 * are the row's other buttons), with its outcome — receipt, error, or the
 * unavailable note — on the line below the row so it never pushes the buttons
 * apart.
 */
export function DiagnosticUpload({
  report,
  disabled = false,
  children,
}: {
  report: DiagnosticReport
  disabled?: boolean
  children?: React.ReactNode
}) {
  const { t, i18n } = useTranslation()
  const [confirm, setConfirm] = React.useState(false)
  const [uploading, setUploading] = React.useState(false)
  const [unavailable, setUnavailable] = React.useState(uploadsUnavailable)
  const [receipt, setReceipt] = React.useState<DiagnosticReceipt | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState(false)
  const busy = React.useRef(false)

  async function upload() {
    if (busy.current) return
    busy.current = true
    setConfirm(false)
    setUploading(true)
    setError(null)
    setReceipt(null)
    setCopied(false)
    try {
      setReceipt(await uploadDiagnosticZip(report))
    } catch (err) {
      if (isUnavailable(err)) {
        uploadsUnavailable = true
        setUnavailable(true)
      } else {
        setError(t('settings.diagnostics.upload.failed', {
          message: err instanceof Error ? err.message : String(err),
        }))
      }
    } finally {
      busy.current = false
      setUploading(false)
    }
  }

  async function copyReceipt() {
    if (!receipt) return
    try {
      await navigator.clipboard.writeText(receipt.receiptId)
      setCopied(true)
      setError(null)
    } catch {
      setError(t('settings.diagnostics.upload.copyFailed'))
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {!unavailable && (
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            disabled={disabled || uploading || !isTauri()}
            onClick={() => setConfirm(true)}
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {t(uploading ? 'settings.diagnostics.upload.uploading' : 'settings.diagnostics.upload.action')}
          </Button>
        )}
        {children}
      </div>
      {unavailable && (
        <p className="text-[12px] text-muted-foreground">{t('settings.diagnostics.upload.unavailable')}</p>
      )}
      {error && <p role="alert" className="text-[12px] text-destructive">{error}</p>}
      {receipt && (
        <div role="status" className="space-y-2 rounded-[10px] border border-border-soft bg-panel px-3 py-2.5">
          <p className="text-[12px] text-ink-2">{t('settings.diagnostics.upload.success')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="select-text break-all font-mono text-[12px] text-foreground">{receipt.receiptId}</code>
            <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={() => void copyReceipt()}>
              <Copy className="h-3.5 w-3.5" />
              {t(copied ? 'settings.diagnostics.upload.copied' : 'settings.diagnostics.upload.copy')}
            </Button>
          </div>
          <p className="font-mono text-[11px] text-faint">
            {t('settings.diagnostics.upload.expires', { date: new Date(receipt.expiresAt).toLocaleString(i18n?.language) })}
          </p>
        </div>
      )}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.diagnostics.upload.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings.diagnostics.upload.consent')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction disabled={disabled || uploading} onClick={() => void upload()}>
              {t('settings.diagnostics.upload.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
