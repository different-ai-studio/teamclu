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

export function DiagnosticUpload({ report, disabled = false }: { report: DiagnosticReport; disabled?: boolean }) {
  const { t, i18n } = useTranslation()
  const [confirm, setConfirm] = React.useState(false)
  const [uploading, setUploading] = React.useState(false)
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
      setError(t('settings.diagnostics.upload.failed', {
        message: err instanceof Error ? err.message : String(err),
      }))
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
    <div className="mb-3 space-y-2">
      <p className="text-[12px] text-muted-foreground">{t('settings.diagnostics.upload.description')}</p>
      <Button variant="outline" size="sm" className="gap-2" disabled={disabled || uploading || !isTauri()} onClick={() => setConfirm(true)}>
        {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
        {t(uploading ? 'settings.diagnostics.upload.uploading' : 'settings.diagnostics.upload.action')}
      </Button>
      {error && <p role="alert" className="text-[12px] text-destructive">{error}</p>}
      {receipt && (
        <div role="status" className="rounded-md border border-border bg-paper p-3 space-y-2">
          <p className="text-[12px]">{t('settings.diagnostics.upload.success')}</p>
          <code className="block select-text break-all text-[12px]">{receipt.receiptId}</code>
          <p className="text-[12px] text-muted-foreground">
            {t('settings.diagnostics.upload.expires', { date: new Date(receipt.expiresAt).toLocaleString(i18n?.language) })}
          </p>
          <Button variant="outline" size="sm" className="gap-2" onClick={() => void copyReceipt()}>
            <Copy className="h-4 w-4" />
            {t(copied ? 'settings.diagnostics.upload.copied' : 'settings.diagnostics.upload.copy')}
          </Button>
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
