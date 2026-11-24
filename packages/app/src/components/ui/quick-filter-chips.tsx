import { cn } from '@/lib/utils'

export interface QuickFilterChip<V extends string> {
  value: V
  label: string
  count: number
}

/**
 * A row of filter chips, each with its count — the tabs atop the sidebar's
 * apps and contacts lists.
 *
 * Ink, not coral: the palette spends coral on unread and send, and a selected
 * filter is neither. A chip whose count is zero stays in place, dimmed, so the
 * row does not reflow when a list is loaded or a row is added.
 */
export function QuickFilterChips<V extends string>({
  value,
  chips,
  onChange,
  ariaLabel,
  testIdPrefix,
  className,
}: {
  value: V
  chips: readonly QuickFilterChip<V>[]
  onChange: (value: V) => void
  ariaLabel: string
  /** `data-testid` of each chip is `${testIdPrefix}-${value}`. */
  testIdPrefix: string
  className?: string
}) {
  return (
    <div role="group" aria-label={ariaLabel} className={cn('flex flex-wrap items-center gap-1', className)}>
      {chips.map((chip) => {
        const selected = value === chip.value
        return (
          <button
            key={chip.value}
            type="button"
            aria-pressed={selected}
            data-testid={`${testIdPrefix}-${chip.value}`}
            onClick={() => onChange(chip.value)}
            className={cn(
              'flex h-6 items-center gap-1 rounded-[7px] px-2 text-[12px] transition-colors',
              selected
                ? 'bg-selected font-semibold text-foreground'
                : 'text-muted-foreground hover:bg-selected/40 hover:text-foreground',
              chip.count === 0 && !selected && 'opacity-50',
            )}
          >
            {chip.label}
            <span className="font-mono text-[10.5px] tabular-nums text-faint">{chip.count}</span>
          </button>
        )
      })}
    </div>
  )
}
