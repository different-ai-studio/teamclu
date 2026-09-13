import { cn } from '@/lib/utils'

/** An app's lifecycle as one dot. `appStatusMeta` decides which tone applies. */
export function AppStatusDot({
  tone,
  className,
}: {
  tone: 'live' | 'ready' | 'failed' | 'idle'
  className?: string
}) {
  const color =
    tone === 'live'
      ? 'bg-[#2eb872]'
      : tone === 'failed'
        ? 'bg-destructive'
        : tone === 'ready'
          ? 'bg-[#2eb872]/70'
          : 'bg-[#e8b54a]'
  return <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', color, className)} />
}
