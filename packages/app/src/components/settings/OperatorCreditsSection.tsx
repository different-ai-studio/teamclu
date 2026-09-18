import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Coins, Loader2, RefreshCw, Search } from 'lucide-react'
import { getBackend } from '@/lib/backend'
import { usePlatformOperator } from '@/lib/admin/platform-operator'
import { useUIStore } from '@/stores/ui'
import { cn } from '@/lib/utils'
import { CREDITS_PER_POINT, formatPoints } from '@/lib/ui/credit-points'
import type { AdminTeamCredits, AdminTeamRow } from '@/lib/backend/types'
import { SectionHeader, SettingCard } from './shared'
import { OperatorOnly, fmtDate, fmtDateTime } from './operator-shared'

/**
 * Credits across every team — operators only.
 *
 * Two views: the list, ranked so the teams closest to running dry come first,
 * and one team's detail, which is where a grant and the member limits are set.
 * Everything with money in it comes from the AI gateway, the ledger's only
 * writer; the list's ranking cannot be paged in the database because of that,
 * which is why the server reads it whole (and says `truncated` when capped).
 *
 * Amounts are shown and typed in POINTS (see lib/ui/credit-points) — the same
 * unit as the team's own billing screen, so an operator and a customer talking
 * about "500" mean the same thing.
 */

const PAGE = 25
type Sort = 'recent' | 'balance' | 'usage'

const pointsToCredits = (points: number) => Math.round(points * CREDITS_PER_POINT)

export function OperatorCreditsSection() {
  const { t } = useTranslation()
  const { loading: whoamiLoading, operator, userId } = usePlatformOperator()
  const orgFilter = useUIStore((s) => s.operatorOrgFilter)
  const clearOrgFilter = useUIStore((s) => s.clearOperatorOrgFilter)

  const [orgId, setOrgId] = useState<string | null>(null)
  const [rows, setRows] = useState<AdminTeamRow[]>([])
  const [total, setTotal] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [page, setPage] = useState(0)
  const [sort, setSort] = useState<Sort>('balance')
  const [term, setTerm] = useState('')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openTeam, setOpenTeam] = useState<string | null>(null)

  // Arriving from an org row: apply its filter once, then forget it, so going
  // back to this screen later is not stuck on last week's org.
  useEffect(() => {
    if (!orgFilter) return
    setOrgId(orgFilter)
    setPage(0)
    setOpenTeam(null)
    clearOrgFilter()
  }, [orgFilter, clearOrgFilter])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const out = await getBackend().admin.listTeams({
        query,
        orgId: orgId ?? undefined,
        sort: sort === 'recent' ? undefined : sort,
        limit: PAGE,
        offset: page * PAGE,
      })
      setRows(out.items)
      setTotal(out.total)
      setTruncated(out.truncated)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [query, orgId, sort, page])

  useEffect(() => {
    if (operator && !openTeam) void load()
  }, [operator, openTeam, load])

  const header = (
    <SectionHeader
      icon={Coins}
      title={t('settings.operatorCredits.title', '额度')}
      description={t(
        'settings.operatorCredits.description',
        'Balances and this month’s spend for every team, lowest balance first. Amounts are points, the same unit a team sees on its own billing screen.',
      )}
    />
  )

  if (whoamiLoading || !operator) {
    return <OperatorOnly header={header} loading={whoamiLoading} userId={userId} />
  }

  if (openTeam) {
    return (
      <TeamCreditsDetail
        teamId={openTeam}
        onBack={() => setOpenTeam(null)}
      />
    )
  }

  const pages = Math.max(1, Math.ceil(total / PAGE))
  const sorts: Array<{ id: Sort; label: string }> = [
    { id: 'balance', label: t('settings.operatorCredits.sortBalance', 'Lowest balance') },
    { id: 'usage', label: t('settings.operatorCredits.sortUsage', 'Biggest spender') },
    { id: 'recent', label: t('settings.operatorCredits.sortRecent', 'Newest') },
  ]

  return (
    <div className="space-y-6">
      <div className="mb-2 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">{header}</div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          aria-label={t('settings.operatorCredits.refresh', 'Refresh')}
          className="mt-1 inline-flex shrink-0 items-center gap-1.5 rounded-[7px] border border-border bg-paper px-2.5 py-1.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-selected hover:text-foreground disabled:opacity-40"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          {t('settings.operatorCredits.refresh', 'Refresh')}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <form
          className="flex min-w-0 flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            setPage(0)
            setQuery(term.trim())
          }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-[8px] border border-border bg-paper px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
            <input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder={t('settings.operatorCredits.searchHint', 'Team name or slug')}
              aria-label={t('settings.operatorCredits.search', 'Search teams')}
              className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint"
            />
          </div>
          <button
            type="submit"
            className="shrink-0 rounded-[7px] border border-border bg-paper px-3 py-1.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-selected hover:text-foreground"
          >
            {t('settings.operatorCredits.search', 'Search teams')}
          </button>
        </form>
        <div className="flex shrink-0 items-center gap-1">
          {sorts.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                setSort(s.id)
                setPage(0)
              }}
              className={cn(
                'rounded-[7px] border px-2.5 py-1.5 text-[11.5px] transition-colors',
                sort === s.id
                  ? 'border-border bg-selected text-foreground'
                  : 'border-border bg-paper text-muted-foreground hover:bg-selected hover:text-foreground',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {orgId && (
        <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
          <span>
            {t('settings.operatorCredits.orgFiltered', 'Filtered to one org')}
            {rows[0]?.orgName ? ` · ${rows[0].orgName}` : ''}
          </span>
          <button
            type="button"
            onClick={() => {
              setOrgId(null)
              setPage(0)
            }}
            className="rounded-[6px] border border-border bg-paper px-2 py-0.5 hover:bg-selected hover:text-foreground"
          >
            {t('settings.operatorCredits.clearOrg', 'Show all teams')}
          </button>
        </div>
      )}

      {error && (
        <SettingCard>
          <p className="text-[12.5px] text-destructive" role="alert">
            {error}
          </p>
        </SettingCard>
      )}

      {truncated && (
        <p className="text-[11.5px] text-muted-foreground" data-testid="operator-credits-truncated">
          {t(
            'settings.operatorCredits.truncated',
            'This deployment has more teams than one read returns, so the ranking covers only the first batch.',
          )}
        </p>
      )}

      <SettingCard className="p-0">
        <div className="divide-y divide-border-soft">
          {rows.length === 0 && !loading && (
            <p className="p-4 text-[12.5px] text-muted-foreground">
              {t('settings.operatorCredits.empty', 'No team matches.')}
            </p>
          )}
          {rows.map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={() => setOpenTeam(row.id)}
              data-testid={`operator-team-${row.id}`}
              className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-selected/50"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-[13px] font-semibold text-foreground">{row.name || row.slug}</span>
                  <span className="shrink-0 font-mono text-[10.5px] text-faint">{row.slug}</span>
                </div>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted-foreground">
                  <span className="truncate">{row.orgName ?? t('settings.operatorCredits.noOrg', 'no org')}</span>
                  <span>·</span>
                  <span>{t('settings.operatorCredits.members', '{{n}} people', { n: row.memberCount })}</span>
                  <span>·</span>
                  <span className="font-mono text-[11px] text-faint">{fmtDate(row.createdAt)}</span>
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-mono text-[12px] text-foreground tabular-nums">{formatPoints(row.balanceCredits)}</p>
                {/*
                  Blank rather than "−0". Checked on the formatted value, not
                  the raw one: a team that spent a few thousand credits is a
                  fraction of a point and rounds to 0, which read as "−0" on
                  the live screen.
                */}
                <p className="font-mono text-[10.5px] text-faint tabular-nums">
                  {formatPoints(row.periodCredits) === '0' ? '' : `−${formatPoints(row.periodCredits)}`}
                </p>
              </div>
            </button>
          ))}
        </div>
      </SettingCard>

      <div className="flex items-center justify-between text-[11.5px] text-muted-foreground">
        <span>
          {t('settings.operatorCredits.legend', 'Balance on top, this month’s spend below.')}
          {' · '}
          {t('settings.operatorCredits.total', '{{n}} teams', { n: total })}
        </span>
        <span className="flex items-center gap-2">
          <button
            type="button"
            disabled={page === 0 || loading}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="rounded-[6px] border border-border bg-paper px-2 py-1 disabled:opacity-40"
          >
            {t('settings.operatorCredits.prev', 'Previous')}
          </button>
          <span className="font-mono text-[11px] text-faint tabular-nums">
            {page + 1} / {pages}
          </span>
          <button
            type="button"
            disabled={page + 1 >= pages || loading}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-[6px] border border-border bg-paper px-2 py-1 disabled:opacity-40"
          >
            {t('settings.operatorCredits.next', 'Next')}
          </button>
        </span>
      </div>
    </div>
  )
}

/** One team: what it has, what it spent, what it was given, and its limits. */
function TeamCreditsDetail({ teamId, onBack }: { teamId: string; onBack: () => void }) {
  const { t } = useTranslation()
  const [data, setData] = useState<AdminTeamCredits | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [grantPoints, setGrantPoints] = useState('')
  const [grantNote, setGrantNote] = useState('')
  const [granting, setGranting] = useState(false)
  /**
   * Generated once per filled-in form, not per click: a retry after a network
   * error must carry the SAME key, or the team is credited twice.
   */
  const [grantKey, setGrantKey] = useState(() => crypto.randomUUID())

  const [savingQuotas, setSavingQuotas] = useState(false)
  const [period, setPeriod] = useState<'week' | 'month'>('month')
  const [defaultLimit, setDefaultLimit] = useState('')
  const [lowBalance, setLowBalance] = useState('')
  const [memberLimits, setMemberLimits] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const out = await getBackend().admin.getTeamCredits(teamId)
      setData(out)
      setPeriod(out.quotas.period)
      setDefaultLimit(out.quotas.defaultLimitCredits === null ? '' : String(out.quotas.defaultLimitCredits / CREDITS_PER_POINT))
      setLowBalance(out.quotas.lowBalanceCredits === null ? '' : String(out.quotas.lowBalanceCredits / CREDITS_PER_POINT))
      setMemberLimits(
        Object.fromEntries(
          out.quotas.members.map((m) => [
            m.actorId,
            m.limitCredits === null ? '' : String(m.limitCredits / CREDITS_PER_POINT),
          ]),
        ),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [teamId])

  useEffect(() => {
    void load()
  }, [load])

  const grant = useCallback(async () => {
    const points = Number(grantPoints)
    if (!Number.isFinite(points) || points <= 0) return
    setGranting(true)
    setError(null)
    setNotice(null)
    try {
      const res = await getBackend().teams.topUpCredits(teamId, {
        amountCredits: pointsToCredits(points),
        idempotencyKey: `operator-grant:${grantKey}`,
        kind: 'grant',
        note: grantNote.trim() || null,
      })
      setNotice(
        res.applied
          ? t('settings.operatorCredits.granted', 'Granted. New balance: {{points}} points', {
              points: formatPoints(res.balanceCredits),
            })
          : t('settings.operatorCredits.grantDuplicate', 'Already applied — the balance is unchanged.'),
      )
      setGrantPoints('')
      setGrantNote('')
      setGrantKey(crypto.randomUUID())
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setGranting(false)
    }
  }, [grantPoints, grantNote, grantKey, teamId, load, t])

  const saveQuotas = useCallback(async () => {
    setSavingQuotas(true)
    setError(null)
    setNotice(null)
    const parse = (raw: string): number | null => {
      const v = raw.trim()
      if (!v) return null
      const n = Number(v)
      return Number.isFinite(n) && n >= 0 ? pointsToCredits(n) : null
    }
    try {
      await getBackend().admin.setTeamQuotas(teamId, {
        period,
        defaultLimitCredits: parse(defaultLimit),
        lowBalanceCredits: parse(lowBalance),
        members: Object.entries(memberLimits).map(([actorId, raw]) => ({
          actorId,
          limitCredits: parse(raw),
        })),
      })
      setNotice(t('settings.operatorCredits.quotasSaved', 'Limits saved.'))
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingQuotas(false)
    }
  }, [teamId, period, defaultLimit, lowBalance, memberLimits, load, t])

  const actors = useMemo(() => data?.actors ?? [], [data])

  return (
    <div className="space-y-6" data-testid="operator-team-detail">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {t('settings.operatorCredits.back', 'All teams')}
      </button>

      {loading && !data && (
        <div className="flex h-20 items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      )}

      {error && (
        <SettingCard>
          <p className="text-[12.5px] text-destructive" role="alert">
            {error}
          </p>
        </SettingCard>
      )}
      {notice && (
        <SettingCard>
          <p className="text-[12.5px] text-ink-2" role="status">
            {notice}
          </p>
        </SettingCard>
      )}

      {data && (
        <>
          <SettingCard>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="truncate text-[15px] font-bold text-foreground">{data.team.name || data.team.slug}</p>
                {/*
                  Slug and org are dropped when they only repeat the name: on
                  real data the three were identical, and the line read
                  "958233718 · 958233718 · 2026/9/4".
                */}
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted-foreground">
                  {data.team.slug !== (data.team.name || '') && (
                    <>
                      <span className="font-mono text-[11px] text-faint">{data.team.slug}</span>
                      <span>·</span>
                    </>
                  )}
                  {data.team.orgName && data.team.orgName !== data.team.name && (
                    <>
                      <span>{data.team.orgName}</span>
                      <span>·</span>
                    </>
                  )}
                  <span className="font-mono text-[11px] text-faint">{fmtDate(data.team.createdAt)}</span>
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-mono text-[18px] font-semibold text-foreground tabular-nums">
                  {formatPoints(data.balanceCredits)}
                </p>
                <p className="text-[10.5px] text-faint">
                  {t('settings.operatorCredits.balanceLabel', 'points left')}
                </p>
                <p className="mt-1 font-mono text-[11px] text-muted-foreground tabular-nums">
                  −{formatPoints(data.usage.summary.credits)} {t('settings.operatorCredits.thisMonth', 'this month')}
                </p>
              </div>
            </div>
          </SettingCard>

          <SettingCard>
            <p className="mb-3 text-[13px] font-semibold">{t('settings.operatorCredits.grantTitle', 'Grant credits')}</p>
            <div className="flex flex-wrap items-end gap-2">
              <label className="block space-y-1">
                <span className="block text-[11.5px] text-muted-foreground">
                  {t('settings.operatorCredits.grantAmount', 'Points')}
                </span>
                <input
                  value={grantPoints}
                  onChange={(e) => setGrantPoints(e.target.value)}
                  inputMode="decimal"
                  aria-label={t('settings.operatorCredits.grantAmount', 'Points')}
                  className="w-32 rounded-[6px] border border-border bg-background px-2 py-1 font-mono text-[12.5px] outline-none"
                />
              </label>
              <label className="block min-w-0 flex-1 space-y-1">
                <span className="block text-[11.5px] text-muted-foreground">
                  {t('settings.operatorCredits.grantNote', 'Note (the team owner sees this)')}
                </span>
                <input
                  value={grantNote}
                  onChange={(e) => setGrantNote(e.target.value)}
                  aria-label={t('settings.operatorCredits.grantNote', 'Note (the team owner sees this)')}
                  className="w-full rounded-[6px] border border-border bg-background px-2 py-1 text-[12.5px] outline-none"
                />
              </label>
              <button
                type="button"
                onClick={() => void grant()}
                disabled={granting || !grantPoints.trim()}
                className="rounded-[7px] border border-border bg-paper px-3 py-1.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-selected hover:text-foreground disabled:opacity-40"
              >
                {granting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  t('settings.operatorCredits.grantSubmit', 'Grant')
                )}
              </button>
            </div>
            <p className="mt-2 text-[10.5px] text-faint">
              {t(
                'settings.operatorCredits.grantHint',
                'Recorded as a grant, not a payment, so it stays out of revenue. Paid top-ups arrive over the payment webhook instead.',
              )}
            </p>
          </SettingCard>

          <SettingCard>
            <p className="mb-3 text-[13px] font-semibold">{t('settings.operatorCredits.limitsTitle', 'Limits')}</p>
            <div className="grid gap-3 sm:grid-cols-3">
              {/*
                Not a <label>: a label with no `for` binds to the first
                labelable descendant, which here is a button — and its
                accessible name then becomes the whole caption plus both
                options. A group with its own label keeps each option nameable.
              */}
              <div className="block space-y-1" role="group" aria-label={t('settings.operatorCredits.period', 'Period')}>
                <span className="block text-[11.5px] text-muted-foreground">
                  {t('settings.operatorCredits.period', 'Period')}
                </span>
                <div className="flex items-center gap-1">
                  {(['week', 'month'] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPeriod(p)}
                      className={cn(
                        'rounded-[6px] border px-2 py-1 text-[11.5px]',
                        period === p
                          ? 'border-border bg-selected text-foreground'
                          : 'border-border bg-paper text-muted-foreground hover:bg-selected',
                      )}
                    >
                      {p === 'week'
                        ? t('settings.operatorCredits.periodWeek', 'Weekly')
                        : t('settings.operatorCredits.periodMonth', 'Monthly')}
                    </button>
                  ))}
                </div>
              </div>
              <label className="block space-y-1">
                <span className="block text-[11.5px] text-muted-foreground">
                  {t('settings.operatorCredits.defaultLimit', 'Default per member')}
                </span>
                <input
                  value={defaultLimit}
                  onChange={(e) => setDefaultLimit(e.target.value)}
                  inputMode="decimal"
                  placeholder={t('settings.operatorCredits.noLimit', 'no limit')}
                  aria-label={t('settings.operatorCredits.defaultLimit', 'Default per member')}
                  className="w-full rounded-[6px] border border-border bg-background px-2 py-1 font-mono text-[12.5px] outline-none"
                />
              </label>
              <label className="block space-y-1">
                <span className="block text-[11.5px] text-muted-foreground">
                  {t('settings.operatorCredits.lowBalance', 'Low-balance warning')}
                </span>
                <input
                  value={lowBalance}
                  onChange={(e) => setLowBalance(e.target.value)}
                  inputMode="decimal"
                  placeholder={t('settings.operatorCredits.noLimit', 'no limit')}
                  aria-label={t('settings.operatorCredits.lowBalance', 'Low-balance warning')}
                  className="w-full rounded-[6px] border border-border bg-background px-2 py-1 font-mono text-[12.5px] outline-none"
                />
              </label>
            </div>

            {actors.length > 0 && (
              <div className="mt-4 divide-y divide-border-soft border-t border-border-soft">
                {actors.map((a) => (
                  <div key={a.id} className="flex items-center gap-3 py-2" data-testid={`operator-quota-${a.id}`}>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2">
                      {a.displayName || a.id}
                      {a.actorType === 'agent' && (
                        <span className="ml-1.5 text-[10.5px] text-faint">
                          {t('settings.operatorCredits.agent', 'agent')}
                        </span>
                      )}
                    </span>
                    <input
                      value={memberLimits[a.id] ?? ''}
                      onChange={(e) => setMemberLimits((prev) => ({ ...prev, [a.id]: e.target.value }))}
                      inputMode="decimal"
                      placeholder={t('settings.operatorCredits.usesDefault', 'uses the default')}
                      aria-label={`${a.displayName || a.id} ${t('settings.operatorCredits.limit', 'limit')}`}
                      className="w-32 shrink-0 rounded-[6px] border border-border bg-background px-2 py-1 font-mono text-[12px] outline-none"
                    />
                  </div>
                ))}
              </div>
            )}

            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-[10.5px] text-faint">
                {t(
                  'settings.operatorCredits.limitsHint',
                  'Blank means no limit. The period is team-wide: per-member periods would make “used this period” incomparable between people.',
                )}
              </p>
              <button
                type="button"
                onClick={() => void saveQuotas()}
                disabled={savingQuotas}
                className="shrink-0 rounded-[7px] border border-border bg-paper px-3 py-1.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-selected hover:text-foreground disabled:opacity-40"
              >
                {savingQuotas ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  t('settings.operatorCredits.saveLimits', 'Save limits')
                )}
              </button>
            </div>
          </SettingCard>

          <SettingCard className="p-0">
            <p className="px-4 pt-4 text-[13px] font-semibold">
              {t('settings.operatorCredits.ledgerTitle', 'Top-ups and grants')}
            </p>
            <div className="divide-y divide-border-soft">
              {data.ledger.length === 0 && (
                <p className="p-4 text-[12.5px] text-muted-foreground">
                  {t('settings.operatorCredits.ledgerEmpty', 'Nothing yet.')}
                </p>
              )}
              {data.ledger.map((row) => (
                <div key={row.id} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-[12.5px] text-ink-2">
                      {t(`settings.billing.kind.${row.kind}`, row.kind)}
                      {row.note && <span className="ml-2 text-[11.5px] text-faint">{row.note}</span>}
                    </p>
                    <p className="font-mono text-[10.5px] text-faint">{fmtDateTime(row.createdAt)}</p>
                  </div>
                  <span
                    className={cn(
                      'shrink-0 font-mono text-[12px] tabular-nums',
                      row.amountCredits < 0 ? 'text-destructive' : 'text-foreground',
                    )}
                  >
                    {row.amountCredits < 0 ? '−' : '+'}
                    {formatPoints(Math.abs(row.amountCredits))}
                  </span>
                </div>
              ))}
            </div>
          </SettingCard>
        </>
      )}
    </div>
  )
}
