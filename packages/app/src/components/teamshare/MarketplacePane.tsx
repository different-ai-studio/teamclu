import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Store, Search, Check, ArrowLeft, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useTeamShareBrowserStore } from '@/stores/team-share-browser'
import { getBackend } from '@/lib/backend/provider'
import {
  TEAM_SKILL_CATEGORIES,
  type TeamSkill,
  type TeamSkillCategory,
} from '@/lib/backend/cloud-api/team-skills'
import type {
  MarketplaceSkill,
  MarketplaceSkillDetail,
} from '@/lib/backend/cloud-api/marketplace'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { resolveAgentDevicePresenceSync } from '@/lib/agent-device-reachability'
import { useActorPresenceStore } from '@/stores/actor-presence-store'

const CACHE_KEY = 'teamclu.marketplace.catalog.v1'

function readCache(): MarketplaceSkill[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeCache(items: MarketplaceSkill[]) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(items))
  } catch {
    /* ignore quota */
  }
}

export function MarketplacePane({ slug }: { slug?: string }) {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const openDetail = useTeamShareBrowserStore((s) => s.openDetail)
  const adoptMarketplaceSkill = useTeamShareBrowserStore((s) => s.adoptMarketplaceSkill)
  const loadSection = useTeamShareBrowserStore((s) => s.loadSection)
  const installSkill = useTeamShareBrowserStore((s) => s.installSkill)
  const subjectActorId = useTeamShareBrowserStore((s) => s.subjectActorId)
  const installedSkills = useTeamShareBrowserStore((s) => s.skills.items)
  useActorPresenceStore((s) =>
    subjectActorId ? s.byActorId[subjectActorId]?.online : undefined,
  )
  const agentOffline = subjectActorId
    ? resolveAgentDevicePresenceSync(subjectActorId) === 'offline'
    : false

  const [market, setMarket] = React.useState<'team' | 'public'>('team')
  const [items, setItems] = React.useState<MarketplaceSkill[]>(() => readCache())
  const [teamItems, setTeamItems] = React.useState<TeamSkill[]>([])
  const [offline, setOffline] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [q, setQ] = React.useState('')
  const [teamQ, setTeamQ] = React.useState('')
  const [category, setCategory] = React.useState<TeamSkillCategory | 'all'>('all')
  const [detail, setDetail] = React.useState<MarketplaceSkillDetail | null>(null)
  const [adopting, setAdopting] = React.useState(false)
  const [installing, setInstalling] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!teamId || market !== 'team') return
    let cancelled = false
    ;(async () => {
      try {
        const list = await getBackend().teamSkills.listTeamSkills(
          teamId,
          subjectActorId ? { actorId: subjectActorId } : {},
        )
        if (!cancelled) setTeamItems(list)
      } catch (error) {
        if (!cancelled) toast.error(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => { cancelled = true }
  }, [teamId, subjectActorId, market])

  /**
   * `items.length` used to sit in this callback's deps while the body calls
   * setItems, so the first successful load changed `reload`'s identity and the
   * effect below re-fired — every mount fetched the catalog twice. The offline
   * fallback needs the current length, not a reactive dependency on it, so it
   * reads through the functional updater instead.
   */
  const reload = React.useCallback(async (query: string, cat: TeamSkillCategory | 'all') => {
    setLoading(true)
    try {
      const backend = getBackend()
      const list = await backend.marketplace.listMarketplaceSkills({
        q: query.trim() || undefined,
        category: cat === 'all' ? undefined : cat,
        teamId: teamId ?? undefined,
      })
      setItems(list)
      writeCache(list)
      setOffline(false)
    } catch {
      setOffline(true)
      setItems((prev) => (prev.length ? prev : readCache()))
    } finally {
      setLoading(false)
    }
  }, [teamId])

  // Debounced: the search box drives this directly, and each request also costs
  // a requireActorForTeam plus a team_skills adoption scan server-side, so one
  // per keystroke is not free. Category and team changes go through the same
  // timer — a 250ms delay on a dropdown is imperceptible and keeps one path.
  React.useEffect(() => {
    if (market !== 'public') return
    const timer = setTimeout(() => {
      void reload(q, category)
    }, 250)
    return () => clearTimeout(timer)
  }, [q, category, reload, market])

  React.useEffect(() => {
    if (!slug) {
      setDetail(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const d = await getBackend().marketplace.getMarketplaceSkill(slug, {
          teamId: teamId ?? undefined,
        })
        if (!cancelled) setDetail(d)
      } catch {
        if (!cancelled) toast.error(t('teamShare.marketplaceLoadFailed', '无法加载市场详情'))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [slug, teamId, t])

  const onAdopt = async (marketplaceSlug: string) => {
    if (!teamId) return
    setAdopting(true)
    try {
      await adoptMarketplaceSkill(marketplaceSlug)
      toast.success(t('teamShare.marketplaceAdopted', '已引入团队'))
      await loadSection('skills')
      void reload(q, category)
      if (slug) {
        const d = await getBackend().marketplace.getMarketplaceSkill(slug, { teamId })
        setDetail(d)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setAdopting(false)
    }
  }

  if (slug && detail) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto">
        <div className="flex items-center gap-3 border-b border-border px-5 py-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => openDetail({ kind: 'marketplace' })}
            title={t('common.back', '返回')}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-bold text-foreground">
              {detail.displayName}{' '}
              <span className="font-mono text-[11px] font-normal text-faint">{detail.slug}</span>
            </div>
            <div className="text-[12px] text-muted-foreground">{detail.publisher}</div>
          </div>
          {detail.adoptedByTeam ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => openDetail({ kind: 'skill', id: detail.adoptedByTeam!.slug })}
            >
              {t('teamShare.marketplaceInTeam', '已在团队里')}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={adopting || !teamId}
              onClick={() => void onAdopt(detail.slug)}
            >
              {adopting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t('teamShare.marketplaceAdopt', '引入团队')}
            </Button>
          )}
        </div>

        <div className="space-y-4 px-6 py-5 text-[13.5px] leading-relaxed text-ink-2">
          <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-faint">
            <span>{detail.category}</span>
            <span>·</span>
            <span>
              {t('teamShare.marketplaceVersion', '市场')} v{detail.latestVersion}
            </span>
            {typeof detail.adoptCount === 'number' ? (
              <>
                <span>·</span>
                <span>
                  {t('teamShare.marketplaceAdoptCount', '已被 {{n}} 个团队引入', {
                    n: detail.adoptCount,
                  })}
                </span>
              </>
            ) : null}
          </div>
          <p className="text-foreground">{detail.summary}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">
                {t('teamShare.whenToUse', '何时使用')}
              </div>
              <p className="whitespace-pre-wrap">{detail.whenToUse || '—'}</p>
            </div>
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">
                {t('teamShare.whenNotToUse', '何时不要用')}
              </div>
              <p className="whitespace-pre-wrap">{detail.whenNotToUse || '—'}</p>
            </div>
          </div>
          {detail.requires ? (
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">
                {t('teamShare.requires', '依赖')}
              </div>
              <pre className="overflow-x-auto rounded-md bg-panel p-3 font-mono text-[12px]">
                {JSON.stringify(detail.requires, null, 2)}
              </pre>
            </div>
          ) : null}
          <div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">
              {t('teamShare.versions', '版本')}
            </div>
            <ul className="space-y-2">
              {detail.versions.map((v) => (
                <li key={v.version} className="rounded-md border border-border-soft bg-paper px-3 py-2">
                  <div className="font-mono text-[11px] text-faint">v{v.version}</div>
                  <div className="text-[12.5px] text-foreground">{v.changelog}</div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-panel text-muted-foreground">
          <Store className="h-[17px] w-[17px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-bold text-foreground">
            {t('teamShare.marketplaceTitle', 'Skills 市场')}
            {offline ? (
              <span className="ml-2 font-mono text-[10.5px] font-normal text-faint">
                {t('common.offline', '离线')}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex rounded-lg bg-panel p-0.5 text-[12px]">
          <button
            type="button"
            className={cn('rounded-md px-3 py-1.5', market === 'team' && 'bg-paper text-foreground')}
            onClick={() => setMarket('team')}
          >
            {t('teamShare.marketTeam', '团队')}
          </button>
          <button
            type="button"
            className={cn('rounded-md px-3 py-1.5', market === 'public' && 'bg-paper text-foreground')}
            onClick={() => setMarket('public')}
          >
            {t('teamShare.marketPublic', '公共')}
          </button>
        </div>
        <div className="relative w-40">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
          <Input
            value={market === 'team' ? teamQ : q}
            onChange={(e) => market === 'team' ? setTeamQ(e.target.value) : setQ(e.target.value)}
            className="h-8 pl-7 text-[12.5px]"
            placeholder={t('common.search', '搜索')}
          />
        </div>
        {market === 'public' && <Select
          value={category}
          onValueChange={(v) => setCategory(v as TeamSkillCategory | 'all')}
        >
          <SelectTrigger className="h-8 w-32 text-[12px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('common.all', '全部')}</SelectItem>
            {TEAM_SKILL_CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {market === 'team' ? (
          <ul className="space-y-1">
            {teamItems
              .filter((item) => !teamQ.trim() || `${item.slug} ${item.summary ?? ''}`.toLowerCase().includes(teamQ.trim().toLowerCase()))
              .map((item) => {
                const installed = installedSkills.some(
                  (actual) => actual.slug === item.slug && actual.installed,
                )
                return (
                  <li key={item.slug} className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-selected">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-semibold text-foreground">{item.slug}</div>
                      <div className="line-clamp-1 text-[12px] text-muted-foreground">{item.summary}</div>
                    </div>
                    {installed ? (
                      <span className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground">
                        <Check className="h-3.5 w-3.5" />{t('teamShare.skillInstalled', '已安装')}
                      </span>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 text-[12px]"
                        disabled={!subjectActorId || agentOffline || installing === item.slug}
                        onClick={() => void (async () => {
                          setInstalling(item.slug)
                          try { await installSkill(item.slug) }
                          catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
                          finally { setInstalling(null) }
                        })()}
                      >
                        {!subjectActorId
                          ? t('teamShare.selectAgentFirst', '先选择 Agent')
                          : agentOffline
                            ? t('common.offline', '离线')
                            : t('teamShare.installToAgent', '安装到 Agent')}
                      </Button>
                    )}
                  </li>
                )
              })}
          </ul>
        ) : loading && !items.length ? (
          <div className="flex justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <div className="px-3 py-10 text-center text-[13px] text-muted-foreground">
            {t('teamShare.marketplaceEmpty', '目录为空')}
          </div>
        ) : (
          <ul className="space-y-1">
            {items.map((item) => (
              <li key={item.slug}>
                {/*
                  A div, not a button: the adopt control below is itself a
                  <button>, and a button inside a button is invalid markup that
                  browsers are free to reparent during HTML parsing — the adopt
                  control could end up outside the row, or dead. The row keeps
                  keyboard access through role/tabIndex.
                */}
                <div
                  role="button"
                  tabIndex={0}
                  className={cn(
                    'flex w-full cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-selected',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  )}
                  onClick={() => openDetail({ kind: 'marketplace-item', slug: item.slug })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      openDetail({ kind: 'marketplace-item', slug: item.slug })
                    }
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold text-foreground">
                      {item.displayName}{' '}
                      <span className="font-mono text-[11px] font-normal text-faint">
                        {item.slug}
                      </span>
                    </div>
                    <div className="line-clamp-1 text-[12px] text-muted-foreground">
                      {item.summary}
                    </div>
                  </div>
                  <div className="shrink-0 pt-0.5" onClick={(e) => e.stopPropagation()}>
                    {item.adoptedByTeam ? (
                      <span className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground">
                        <Check className="h-3.5 w-3.5" />
                        {item.adoptedByTeam.upstreamSubscribed
                          ? t('teamShare.marketplaceFollowing', '团队 v{{tv}} · 跟随市场 v{{mv}}', {
                              tv: item.adoptedByTeam.latestVersion,
                              mv: item.latestVersion,
                            })
                          : t('teamShare.marketplaceDetached', '已断开')}
                      </span>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 text-[12px]"
                        disabled={adopting || !teamId}
                        onClick={() => void onAdopt(item.slug)}
                      >
                        {t('teamShare.marketplaceAdopt', '引入团队')}
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
