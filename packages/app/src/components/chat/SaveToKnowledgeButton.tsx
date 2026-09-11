import { useState } from 'react'
import { BookmarkPlus, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { proposeSessionToKnowledge } from '@/lib/knowledge/propose-from-session'

export function SaveToKnowledgeButton({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)

  return (
    <button
      type="button"
      data-testid="save-to-knowledge-button"
      disabled={busy}
      onClick={() => {
        if (busy) return
        setBusy(true)
        void proposeSessionToKnowledge(sessionId)
          .then(() => {
            toast.success(t('knowledgeReview.opened', '已打开审稿页，确认后才会写入知识库'))
          })
          .catch((err) => {
            toast.error(err instanceof Error ? err.message : String(err))
          })
          .finally(() => setBusy(false))
      }}
      className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
      title={t('knowledgeReview.headerAction', '整理到知识库')}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BookmarkPlus className="h-3.5 w-3.5" />}
    </button>
  )
}
