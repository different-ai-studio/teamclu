import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { SettingCard } from './shared'

/**
 * What an operator screen shows before it knows, and to everyone else.
 *
 * Every operator endpoint checks the caller again on the server, so this is a
 * courtesy, not a guard. Showing the caller's own user id is the useful part:
 * it is the value the deployment's PLATFORM_OPERATOR_USER_IDS lists.
 */
export function OperatorOnly({
  header,
  loading,
  userId,
}: {
  header: ReactNode
  loading: boolean
  userId: string | null
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-6">
      {header}
      {loading ? (
        <div className="flex h-20 items-center justify-center" data-testid="operator-loading">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <SettingCard data-testid="operator-only">
          <p className="text-[12.5px] text-ink-2">
            {t('settings.operator.operatorsOnly', 'Only platform operators of this deployment can see this.')}
          </p>
          {userId && (
            <p className="mt-3 text-[11.5px] text-muted-foreground">
              {t('settings.operator.yourUserId', 'Your user id')}:{' '}
              <span className="select-all font-mono text-[11.5px] text-ink-2">{userId}</span>
            </p>
          )}
        </SettingCard>
      )}
    </div>
  )
}

/** Date only: these screens compare days, not minutes. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '—' : at.toLocaleDateString()
}

/** Date and time, for a ledger row where the minute matters. */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '—' : at.toLocaleString()
}
