import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import {
  APP_RELATIONSHIP_FILTERS,
  APP_RELATIONSHIP_LABELS,
  type AppRelationshipFilter,
} from '@/lib/apps/app-relationship'

/**
 * All · Mine · Invited · Team, each with its count.
 *
 * Ink, not coral: the palette spends coral on unread and send, and a selected
 * filter is neither. A chip whose count is zero stays in place, dimmed, so the
 * row does not reflow when a list is loaded or an app is created.
 */
export function AppRelationshipChips({
  value,
  counts,
  onChange,
  className,
}: {
  value: AppRelationshipFilter
  counts: Record<AppRelationshipFilter, number>
  onChange: (filter: AppRelationshipFilter) => void
  className?: string
}) {
  const { t } = useTranslation()
  return (
    <div
      role="group"
      aria-label={t('apps.relationshipFilter', '按关系筛选')}
      className={cn('flex flex-wrap items-center gap-1', className)}
    >
      {APP_RELATIONSHIP_FILTERS.map((filter) => {
        const label = APP_RELATIONSHIP_LABELS[filter]
        const selected = value === filter
        const empty = counts[filter] === 0
        return (
          <button
            key={filter}
            type="button"
            aria-pressed={selected}
            data-testid={`app-relationship-chip-${filter}`}
            onClick={() => onChange(filter)}
            className={cn(
              'flex h-6 items-center gap-1 rounded-[7px] px-2 text-[12px] transition-colors',
              selected
                ? 'bg-selected font-semibold text-foreground'
                : 'text-muted-foreground hover:bg-selected/40 hover:text-foreground',
              empty && !selected && 'opacity-50',
            )}
          >
            {t(label.key, label.fallback)}
            <span className="font-mono text-[10.5px] tabular-nums text-faint">{counts[filter]}</span>
          </button>
        )
      })}
    </div>
  )
}
