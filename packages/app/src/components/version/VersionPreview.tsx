import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { SimpleDiff } from '@/components/version/simple-diff'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

type TabMode = 'content' | 'diff'

interface VersionPreviewProps {
  /** Whether a version is currently selected. */
  hasSelection: boolean
  /** Content of the selected version (fetched lazily by the parent). */
  content: string | null
  /** Current (working) content to diff against. */
  currentContent?: string | null
  canRestore: boolean
  onRestore: () => void
  restoring: boolean
}

export function VersionPreview({
  hasSelection,
  content,
  currentContent,
  canRestore,
  onRestore,
  restoring,
}: VersionPreviewProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<TabMode>('content')

  if (!hasSelection) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t('versionHistory.selectVersionPrompt', 'Select a historical version')}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setTab('content')}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs transition-colors',
              tab === 'content'
                ? 'bg-accent font-medium'
                : 'text-muted-foreground hover:bg-accent/50'
            )}
          >
            {t('versionHistory.contentTab', 'Content')}
          </button>
          <button
            onClick={() => setTab('diff')}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs transition-colors',
              tab === 'diff'
                ? 'bg-accent font-medium'
                : 'text-muted-foreground hover:bg-accent/50'
            )}
          >
            {t('versionHistory.diffTab', 'Compare with current')}
          </button>
        </div>

        {canRestore && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="outline" disabled={restoring}>
                {restoring
                  ? t('versionHistory.restoring', 'Restoring...')
                  : t('versionHistory.restoreThisVersion', 'Restore this version')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>{t('versionHistory.restoreTitle', 'Restore this version?')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t(
                    'versionHistory.restoreDescription',
                    'The file will be restored to the local draft and will not sync to the team immediately. This change will be pushed automatically on the next sync.',
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
                <AlertDialogAction onClick={onRestore}>
                  {t('versionHistory.confirmRestore', 'Restore')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      {/* Content area */}
      <ScrollArea className="flex-1">
        {tab === 'content' ? (
          <pre className="p-3 text-xs font-mono leading-relaxed whitespace-pre-wrap break-all">
            {content ?? ''}
          </pre>
        ) : (
          <SimpleDiff oldContent={currentContent ?? ''} newContent={content ?? ''} />
        )}
      </ScrollArea>
    </div>
  )
}
