import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Suspense fallback for a lazily loaded pane or column: a centred spinner that
 * fills whatever box the pane would have filled. Matches the file viewer's
 * existing fallback so lazy boundaries look the same everywhere.
 */
export function PaneLoading({ className }: { className?: string }) {
  return (
    <div className={cn('flex h-full w-full items-center justify-center', className)}>
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  )
}
