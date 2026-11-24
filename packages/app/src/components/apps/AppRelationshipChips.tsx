import { useTranslation } from 'react-i18next'
import { QuickFilterChips } from '@/components/ui/quick-filter-chips'
import {
  APP_RELATIONSHIP_FILTERS,
  APP_RELATIONSHIP_LABELS,
  type AppRelationshipFilter,
  type AppSidebarFilter,
} from '@/lib/apps/app-relationship'

/**
 * The apps quick filter, each chip with its count — All · Mine · Invited · Team
 * in the library, 本机 · Mine · Invited in the sidebar.
 */
export function AppRelationshipChips<F extends AppRelationshipFilter | AppSidebarFilter = AppRelationshipFilter>({
  value,
  counts,
  onChange,
  filters = APP_RELATIONSHIP_FILTERS as readonly F[],
  className,
}: {
  value: F
  counts: Record<F, number>
  onChange: (filter: F) => void
  filters?: readonly F[]
  className?: string
}) {
  const { t } = useTranslation()
  return (
    <QuickFilterChips
      value={value}
      onChange={onChange}
      ariaLabel={t('apps.relationshipFilter', '按关系筛选')}
      testIdPrefix="app-relationship-chip"
      className={className}
      chips={filters.map((filter) => ({
        value: filter,
        label: t(APP_RELATIONSHIP_LABELS[filter].key, APP_RELATIONSHIP_LABELS[filter].fallback),
        count: counts[filter],
      }))}
    />
  )
}
