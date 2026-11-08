import * as React from 'react'
import { cn } from '@/lib/utils'

/** F: coral `@` text — no border, no count. */
export function MentionSignal({
  className,
  'aria-label': ariaLabel,
  'data-testid': testId,
}: {
  className?: string
  'aria-label'?: string
  'data-testid'?: string
}) {
  return (
    <span
      className={cn(
        'shrink-0 text-[12.5px] font-bold leading-none tracking-[0.01em] text-coral',
        className,
      )}
      aria-label={ariaLabel}
      data-testid={testId}
    >
      @
    </span>
  )
}

/** F: hollow coral ring — unread without a filled dot. */
export function UnreadSignal({
  className,
  'aria-label': ariaLabel,
  'data-testid': testId,
}: {
  className?: string
  'aria-label'?: string
  'data-testid'?: string
}) {
  return (
    <span
      className={cn(
        'h-[9px] w-[9px] shrink-0 rounded-full border-2 border-coral bg-transparent',
        className,
      )}
      aria-label={ariaLabel}
      data-testid={testId}
    />
  )
}

/**
 * F: solid coral corner dot on a kind/icon tile. Host must leave overflow
 * visible and a little padding so translate does not clip (never put
 * `truncate` on an ancestor of this host).
 */
export function KindHotDot({
  'data-testid': testId,
}: {
  'data-testid'?: string
}) {
  return (
    <span
      className="pointer-events-none absolute right-0 top-0 h-[7px] w-[7px] translate-x-[35%] -translate-y-[35%] rounded-full bg-coral"
      aria-hidden
      data-testid={testId}
    />
  )
}

/** Padding shell so an outer KindHotDot is never clipped. */
export function KindHotHost({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <span className={cn('-m-[3px] overflow-visible p-[3px]', className)}>
      {children}
    </span>
  )
}
