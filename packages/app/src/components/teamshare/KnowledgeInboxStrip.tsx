import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Inbox } from 'lucide-react'

import { cn } from '@/lib/utils'
import { openKnowledgeReview } from '@/lib/tabs/knowledge-tabs'
import { useKnowledgeInboxStore } from '@/stores/knowledge-inbox'

export function KnowledgeInboxStrip() {
  const { t } = useTranslation()
  const items = useKnowledgeInboxStore((s) => s.items)
  const load = useKnowledgeInboxStore((s) => s.load)

  React.useEffect(() => {
    void load()
  }, [load])

  if (items.length === 0) return null

  return (
    <div className="shrink-0 border-b border-border-soft px-2 py-1.5">
      <div className="px-2 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.8px] text-faint">
        {t('knowledgeReview.pendingKicker', '待写入 · {{count}}', { count: items.length })}
      </div>
      <div className="flex flex-col">
        {items.slice(0, 5).map((item) => (
          <button
            key={item.id}
            type="button"
            data-testid={`knowledge-inbox-${item.id}`}
            onClick={() => openKnowledgeReview(item.id, item.title || t('knowledgeReview.tabLabel', '审稿'))}
            className={cn(
              'flex items-center gap-2 rounded-[8px] px-2 py-1.5 text-left',
              'hover:bg-selected',
            )}
          >
            <Inbox className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
              {item.title || t('knowledgeReview.untitled', '未命名')}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
