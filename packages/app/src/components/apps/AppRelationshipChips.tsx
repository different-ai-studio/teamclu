import { useTranslation } from 'react-i18next'
import { QuickFilterChips } from '@/components/ui/quick-filter-chips'
import {
  APP_SIDEBAR_FILTERS,
  APP_SIDEBAR_FILTER_LABELS,
  type AppSidebarFilter,
} from '@/lib/apps/app-relationship'

/** The sidebar's apps tabs — 本机 · 我的 · 受邀 — each with its count. */
export function AppRelationshipChips({
  value,
  counts,
  onChange,
  className,
}: {
  value: AppSidebarFilter
  counts: Record<AppSidebarFilter, number>
  onChange: (filter: AppSidebarFilter) => void
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
      chips={APP_SIDEBAR_FILTERS.map((filter) => ({
        value: filter,
        label: t(APP_SIDEBAR_FILTER_LABELS[filter].key, APP_SIDEBAR_FILTER_LABELS[filter].fallback),
        count: counts[filter],
      }))}
    />
  )
}
