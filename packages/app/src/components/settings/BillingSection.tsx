import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2, Receipt, Wallet } from 'lucide-react'
import { getBackend } from '@/lib/backend'
import { useCurrentTeamStore } from '@/stores/current-team'
import { cn } from '@/lib/utils'
import type {
  CreditLedgerEntry,
  CreditUsageReport,
  TeamCredits,
} from '@/lib/backend/types'

/**
 * Team billing: balance, what a credit buys, and top-up history.
 *
 * The headline unit is POINTS, not currency. Credits are our own pricing unit
 * and are not anchored to upstream cost, so showing a money figure here would
 * be a different number with a different meaning.
 */

/** Display divisor: the wallet reads in the thousands, a request costs a
 *  fraction of one. No single unit is legible at both ends, so the balance is
 *  shown in points and per-request cost only ever appears aggregated. */
const POINTS_PER_CREDIT = 10_000

const toPoints = (credits: number) => credits / POINTS_PER_CREDIT
const fmtPoints = (credits: number) =>
  toPoints(credits).toLocaleString(undefined, { maximumFractionDigits: 0 })

function fmtTokens(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(2)} 亿`
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)} 万`
  return n.toLocaleString()
}

export function BillingSection() {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)

  const [credits, setCredits] = useState<TeamCredits | null>(null)
  const [usage, setUsage] = useState<CreditUsageReport | null>(null)
  const [ledger, setLedger] = useState<CreditLedgerEntry[] | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  const load = useCallback(async () => {
    if (!teamId) return
    setIsLoading(true)
    setError(null)
    setUnavailable(false)
    try {
      const backend = getBackend()
      const [c, u] = await Promise.all([
        backend.teams.getTeamCredits(teamId),
        backend.teams.getCreditUsage(teamId, { range: 'month' }),
      ])
      setCredits(c)
      setUsage(u)
      // Owner-only. A non-owner gets 403 here and simply sees no history —
      // that is the designed permission split, not an error worth surfacing.
      try {
        const l = await backend.teams.getCreditLedger(teamId, { limit: 20 })
        setLedger(l.items)
      } catch {
        setLedger(null)
      }
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code
      if (code === 'ai_gateway_unavailable') setUnavailable(true)
      else setError((e as Error)?.message ?? String(e))
    } finally {
      setIsLoading(false)
    }
  }, [teamId])

  useEffect(() => { void load() }, [load])

  /** Days of runway from the last 7 days' burn. Hidden when nothing was spent:
   *  an infinity symbol is not a useful answer to "how long do I have". */
  const runwayDays = useMemo(() => {
    if (!credits || !usage) return null
    const start = new Date(usage.startUtc).getTime()
    const elapsedDays = Math.max(1, (Date.now() - start) / 86_400_000)
    const perDay = usage.summary.credits / elapsedDays
    if (perDay <= 0) return null
    return Math.floor(credits.balanceCredits / perDay)
  }, [credits, usage])

  const isEmpty = credits !== null && credits.balanceCredits <= 0

  return (
    <div className="space-y-6">
      <div>
        <h3 className="flex items-center gap-2 text-[15px] font-semibold">
          <Wallet className="h-5 w-5 text-muted-foreground" />
          {t('settings.billing.title', 'Billing')}
        </h3>
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          {t('settings.billing.description', "A shared team wallet. Every member's AI usage is deducted from it.")}
        </p>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-paper px-4 py-3 text-[13px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{t('settings.billing.loading', 'Loading billing…')}</span>
        </div>
      )}

      {unavailable && !isLoading && (
        <div className="rounded-lg border border-border bg-panel px-4 py-3 text-[13px] text-muted-foreground">
          {t('settings.billing.unavailable', 'Team billing is not available yet — the AI gateway is not configured for this deployment.')}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-lg bg-amber-50 px-4 py-3 text-[13px] text-amber-600 dark:bg-amber-950/30">
          <AlertTriangle className="h-4 w-4" />
          <span>{error}</span>
        </div>
      )}

      {credits && !unavailable && (
        <>
          {/* Balance */}
          <section className="rounded-lg border border-border bg-paper px-5 py-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[13px] font-semibold">{t('settings.billing.balance', 'Current balance')}</p>
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  {t('settings.billing.periodLabel', 'This billing period')}
                </p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-end gap-8">
              <Metric
                label={t('settings.billing.available', 'Available')}
                value={fmtPoints(credits.balanceCredits)}
                unit={t('settings.billing.points', 'points')}
                large
                warn={isEmpty}
              />
              <Metric
                label={t('settings.billing.usedThisPeriod', 'Used this period')}
                value={fmtPoints(credits.usedCredits)}
                unit={t('settings.billing.points', 'points')}
              />
              {runwayDays !== null && (
                <Metric
                  label={t('settings.billing.runway', 'At current pace')}
                  value={`≈ ${runwayDays}`}
                  unit={t('settings.billing.days', 'days')}
                />
              )}
            </div>

            {isEmpty && (
              <div className="mt-4 flex items-start gap-3 rounded-lg border border-amber-300/40 bg-amber-50 px-4 py-3 dark:bg-amber-950/30">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-amber-600" />
                <div className="text-amber-700 dark:text-amber-500">
                  <p className="text-[12.5px] font-semibold">
                    {t('settings.billing.emptyTitle', "Balance is used up — the team's AI requests have stopped")}
                  </p>
                  <p className="mt-0.5 text-[12px] opacity-90">
                    {t('settings.billing.emptyBody', 'Topping up restores service immediately; no restart needed. Sessions already running stop at their current step.')}
                  </p>
                </div>
              </div>
            )}
          </section>

          {/* This period's usage, by tier */}
          {usage && (
            <section className="rounded-lg border border-border bg-paper">
              <div className="border-b border-border px-4 py-2.5">
                <p className="text-[13px] font-semibold">{t('settings.billing.usageTitle', "This period's usage")}</p>
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  {t('settings.billing.usageSub', '{{tokens}} tokens · {{requests}} requests', {
                    tokens: fmtTokens(usage.summary.inputTokens + usage.summary.outputTokens),
                    requests: usage.summary.requests.toLocaleString(),
                  })}
                </p>
              </div>
              {usage.byModel.length === 0 ? (
                <p className="px-4 py-6 text-center text-[12.5px] text-muted-foreground">
                  {t('settings.billing.noUsage', 'No usage in this period.')}
                </p>
              ) : (
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="text-[11px] text-muted-foreground">
                      <th className="px-4 pb-2 pt-2 text-left font-medium">{t('settings.billing.tier', 'Tier')}</th>
                      <th className="px-4 pb-2 pt-2 text-right font-medium">Tokens</th>
                      <th className="px-4 pb-2 pt-2 text-right font-medium">{t('settings.billing.pointsUsed', 'Points')}</th>
                      <th className="px-4 pb-2 pt-2 text-right font-medium">{t('settings.billing.share', 'Share')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.byModel.map((m) => {
                      // Share is by CREDITS, not tokens: per-token cost differs
                      // by an order of magnitude across tiers, so a token-based
                      // split tells the opposite story.
                      const pct = usage.summary.credits > 0
                        ? (m.credits / usage.summary.credits) * 100
                        : 0
                      return (
                        <tr key={m.publicModelId} className="border-t border-border-soft">
                          <td className="px-4 py-2 font-medium">{m.publicModelId}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{fmtTokens(m.inputTokens + m.outputTokens)}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{fmtPoints(m.credits)}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{pct.toFixed(1)}%</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
              <p className="border-t border-dashed border-border-soft px-4 py-2.5 text-[11.5px] text-muted-foreground">
                {t('settings.billing.shareNote', 'Share is measured in points, not tokens — per-token cost differs by an order of magnitude across tiers.')}
              </p>
            </section>
          )}

          {/* Top-up history — owner only */}
          {ledger && (
            <section className="rounded-lg border border-border bg-paper">
              <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <Receipt className="h-4 w-4 text-muted-foreground" />
                  <p className="text-[13px] font-semibold">{t('settings.billing.ledger', 'Top-up history')}</p>
                </div>
                <span className="rounded border border-border px-2 py-0.5 text-[10.5px] text-muted-foreground">
                  {t('settings.billing.ownerOnly', 'Owners only')}
                </span>
              </div>
              {ledger.length === 0 ? (
                <p className="px-4 py-6 text-center text-[12.5px] text-muted-foreground">
                  {t('settings.billing.noLedger', 'No top-ups yet.')}
                </p>
              ) : (
                <table className="w-full text-[12.5px]">
                  <tbody>
                    {ledger.map((e) => (
                      <tr key={e.id} className="border-t border-border-soft first:border-t-0">
                        <td className="px-4 py-2 tabular-nums text-muted-foreground">
                          {new Date(e.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-2">
                          <span className="rounded bg-panel px-1.5 py-0.5 text-[10.5px] font-semibold">
                            {t(`settings.billing.kind.${e.kind}`, e.kind)}
                          </span>
                        </td>
                        <td className={cn('px-4 py-2 text-right tabular-nums', e.amountCredits >= 0 ? 'text-emerald-700' : 'text-foreground')}>
                          {e.amountCredits >= 0 ? '+' : ''}{fmtPoints(e.amountCredits)}
                        </td>
                        <td className="px-4 py-2 text-muted-foreground">{e.note ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}
        </>
      )}
    </div>
  )
}

function Metric({ label, value, unit, large, warn }: {
  label: string; value: string; unit: string; large?: boolean; warn?: boolean
}) {
  return (
    <div>
      <span className="block text-[11px] text-muted-foreground">{label}</span>
      <span className={cn(
        'font-mono font-semibold tabular-nums',
        large ? 'text-[30px] leading-none' : 'text-[18px]',
        warn && 'text-amber-600',
      )}>
        {value}
        <span className="ml-1.5 text-[13px] font-medium text-muted-foreground">{unit}</span>
      </span>
    </div>
  )
}

export default BillingSection
