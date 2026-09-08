import { useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  exportTranscriptErrorMessage,
  savePiTranscript,
} from '@/lib/session/pi-transcript-export'

export function ExportPiTranscriptButton({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)

  return (
    <button
      type="button"
      data-testid="export-pi-transcript-button"
      disabled={busy}
      onClick={() => {
        if (busy) return
        setBusy(true)
        void savePiTranscript(sessionId)
          .then((dest) => {
            if (!dest) return
            toast.success(t('chat.exportTranscriptSaved', 'Transcript saved'))
          })
          .catch((err) => {
            toast.error(exportTranscriptErrorMessage(err))
          })
          .finally(() => setBusy(false))
      }}
      className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
      title={t('chat.exportTranscript', 'Export session transcript')}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
    </button>
  )
}
