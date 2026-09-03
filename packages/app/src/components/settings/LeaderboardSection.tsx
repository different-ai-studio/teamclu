import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Trophy, Flame, MessageSquareHeart, Sparkles, RefreshCw, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TEAM_SYNCED_EVENT } from '@/lib/build-config'
import { buildSharedRankMap } from '@/lib/team-leaderboard-ranks'
import { Button } from '@/components/ui/button'
import { fetchTeamLeaderboard } from '@/lib/telemetry/cloud-leaderboard'
import { useCurrentTeamStore } from '@/stores/current-team'

function formatTokens(tokens: number | undefined | null): string {
  if (tokens == null || tokens === 0) {
    return '0'
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(2)}M`
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(2)}K`
  }
  return tokens.toString()
}

// ── Types ──────────────────────────────────────────────────────────

interface LeaderboardStats {
  totalFeedbacks: number
  positiveCount: number
  negativeCount: number
  totalTokens: number
  totalCost: number
  sessionCount: number
  skillUsage?: Record<string, number>
}

interface MemberLeaderboardExport {
  memberId: string
  memberName: string
  exportedAt: string
  updateAt: string
  workspaces: Record<string, LeaderboardStats>  // workspace path -> stats
}

export interface TeamLeaderboard {
  members: MemberLeaderboardExport[]
}

interface MemberStats {
  name: string
  overallRank: number
  overallScore: number
  tokenRank: number
  feedbackRank: number
  skillRank: number
  totalTokens: number
  totalFeedbacks: number
  totalCost: number
  sessionCount: number
  totalSkillInvocations: number
  isCurrentUser?: boolean
}

// ── Component ──────────────────────────────────────────────────────────

export function LeaderboardSection() {
  const { t } = useTranslation()
  const [leaderboard, setLeaderboard] = React.useState<TeamLeaderboard | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    const teamId = useCurrentTeamStore.getState().team?.id
    if (!teamId) {
      setLeaderboard(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await fetchTeamLeaderboard(teamId, "week")
      setLeaderboard(result)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  const handleRefresh = React.useCallback(async () => {
    await load()
    window.dispatchEvent(new CustomEvent(TEAM_SYNCED_EVENT))
  }, [load])

  React.useEffect(() => {
    load()
  }, [load])

  React.useEffect(() => {
    const handler = () => {
      load()
    }
    window.addEventListener(TEAM_SYNCED_EVENT, handler)
    return () => window.removeEventListener(TEAM_SYNCED_EVENT, handler)
  }, [load])

  // Aggregate stats from all workspaces for each member
  const aggregateWorkspaceStats = React.useCallback((workspaces: Record<string, LeaderboardStats>) => {
    const total = {
      totalTokens: 0,
      totalFeedbacks: 0,
      totalCost: 0,
      sessionCount: 0,
      totalSkillInvocations: 0,
    }

    Object.values(workspaces || {}).forEach(stats => {
      total.totalTokens += stats.totalTokens || 0
      total.totalFeedbacks += stats.totalFeedbacks || 0
      total.totalCost += stats.totalCost || 0
      total.sessionCount += stats.sessionCount || 0
      for (const n of Object.values(stats.skillUsage || {})) {
        total.totalSkillInvocations += n
      }
    })

    return total
  }, [])

  // Calculate ranks with aggregated workspace data
  const memberStats: MemberStats[] = React.useMemo(() => {
    if (!leaderboard?.members) return []

    // First, aggregate stats for each member
    const membersWithAggregated = leaderboard.members.map(m => ({
      ...m,
      aggregated: aggregateWorkspaceStats(m.workspaces)
    }))

    const tokenRanks = buildSharedRankMap({
      items: membersWithAggregated,
      getKey: (member) => member.memberName,
      getScore: (member) => member.aggregated.totalTokens,
    })
    const feedbackRanks = buildSharedRankMap({
      items: membersWithAggregated,
      getKey: (member) => member.memberName,
      getScore: (member) => member.aggregated.totalFeedbacks,
    })
    const skillRanks = buildSharedRankMap({
      items: membersWithAggregated,
      getKey: (member) => member.memberName,
      getScore: (member) => member.aggregated.totalSkillInvocations,
    })

    const overallScores = membersWithAggregated.map((member) => ({
      memberName: member.memberName,
      overallScore:
        ((tokenRanks.get(member.memberName) ?? 0) +
          (feedbackRanks.get(member.memberName) ?? 0) +
          (skillRanks.get(member.memberName) ?? 0)) / 3,
    }))
    const overallScoreMap = new Map(
      overallScores.map((member) => [member.memberName, member.overallScore])
    )
    const overallRanks = buildSharedRankMap({
      items: overallScores,
      getKey: (member) => member.memberName,
      getScore: (member) => member.overallScore,
      direction: 'asc',
    })

    return membersWithAggregated.map((member) => ({
      name: member.memberName || 'Unknown',
      overallRank: overallRanks.get(member.memberName) ?? 0,
      overallScore: overallScoreMap.get(member.memberName) ?? 0,
      tokenRank: tokenRanks.get(member.memberName) ?? 0,
      feedbackRank: feedbackRanks.get(member.memberName) ?? 0,
      skillRank: skillRanks.get(member.memberName) ?? 0,
      totalTokens: member.aggregated.totalTokens,
      totalFeedbacks: member.aggregated.totalFeedbacks,
      totalCost: member.aggregated.totalCost,
      sessionCount: member.aggregated.sessionCount,
      totalSkillInvocations: member.aggregated.totalSkillInvocations,
    }))
  }, [leaderboard, aggregateWorkspaceStats])

  const topSkills = React.useMemo(
    () => (leaderboard ? computeTopSkills(leaderboard, 10) : []),
    [leaderboard],
  )

  const teamSummary = React.useMemo(() => {
    const totalTokens = memberStats.reduce((sum, m) => sum + (m.totalTokens ?? 0), 0)
    const totalFeedbacks = memberStats.reduce((sum, m) => sum + (m.totalFeedbacks ?? 0), 0)
    const totalCost = memberStats.reduce((sum, m) => sum + (m.totalCost ?? 0), 0)
    const totalSessions = memberStats.reduce((sum, m) => sum + (m.sessionCount ?? 0), 0)
    return {
      activeUsers: memberStats.length,
      totalFeedbacks,
      totalTokens,
      totalCost,
      totalSessions,
    }
  }, [memberStats])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 shadow-sm">
            <Trophy className="h-4.5 w-4.5 text-white" />
          </div>
          <div>
            <h2 className="text-base font-semibold">{t('settings.leaderboard.title', 'Team Leaderboard')}</h2>
            <p className="text-xs text-muted-foreground">
              {memberStats.length} {t('settings.leaderboard.members', 'members')}
            </p>
          </div>
        </div>

        {/* Actions */}
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={loading}
          className="gap-1.5"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {t('settings.leaderboard.refresh', 'Refresh')}
        </Button>
      </div>

      {error && (
        <p className="text-[13px] text-destructive">{error}</p>
      )}

      {memberStats.length === 0 && !loading && (
        <p className="text-[13px] text-muted-foreground">
          {t('settings.leaderboard.noData', 'No leaderboard data yet. Your stats will be automatically synced when you complete sessions or provide feedback.')}
        </p>
      )}

      {/* Team summary cards */}
      {memberStats.length > 0 && (
        <div className="grid grid-cols-4 gap-3">
          {[
            { label: t('settings.leaderboard.activeUsers', 'Active Users'), value: teamSummary.activeUsers, icon: '👥' },
            { label: t('settings.leaderboard.totalFeedbacks', 'Total Feedbacks'), value: teamSummary.totalFeedbacks, icon: '💬' },
            { label: t('settings.leaderboard.totalTokens', 'Total Tokens'), value: formatTokens(teamSummary.totalTokens), icon: '🔥' },
            { label: t('settings.leaderboard.totalCost', 'Total Cost'), value: `$${teamSummary.totalCost.toFixed(2)}`, icon: '💰' },
          ].map((item) => (
            <div
              key={item.label}
              className="rounded-xl border bg-card p-3 text-center"
            >
              <div className="text-lg mb-0.5">{item.icon}</div>
              <div className="text-lg font-bold">{item.value}</div>
              <div className="text-[10px] text-muted-foreground">{item.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Leaderboard table */}
      {memberStats.length > 0 && (
        <>
          <div className="rounded-xl border bg-card overflow-hidden">
            {/* Table header */}
            <div className="grid grid-cols-[40px_1fr_72px_72px_72px_112px] items-center gap-2 px-4 py-2.5 bg-muted/30 border-b text-[11px] font-medium text-muted-foreground">
              <span className="text-center">{t('settings.leaderboard.rank', '#')}</span>
              <span>{t('settings.leaderboard.member', 'Member')}</span>
              <span className="text-center">{t('settings.leaderboard.tokenRank', 'Token Rank')}</span>
              <span className="text-center">{t('settings.leaderboard.feedbackRank', 'Feedback Rank')}</span>
              <span className="text-center">{t('settings.leaderboard.skillRank', 'Skill Rank')}</span>
              <span className="text-right">{t('settings.leaderboard.totalTokens', 'Total Tokens')}</span>
            </div>

            {/* Rows - sorted by overall performance (average of ranks) */}
            {[...memberStats]
              .sort((a, b) => {
                return a.overallScore - b.overallScore
                  || b.totalTokens - a.totalTokens
                  || b.totalFeedbacks - a.totalFeedbacks
                  || a.name.localeCompare(b.name)
              })
              .map((member) => {
                const rank = member.overallRank
                return (
                  <div
                    key={member.name}
                    className={cn(
                      "grid grid-cols-[40px_1fr_72px_72px_72px_112px] items-center gap-2 px-4 py-2.5 border-b last:border-b-0 transition-colors",
                      member.isCurrentUser
                        ? "bg-indigo-500/[0.06]"
                        : "hover:bg-muted/30"
                    )}
                  >
                    {/* Rank */}
                    <div className="flex justify-center">
                      {rank <= 3 ? (
                        <span className="text-base">
                          {rank === 1 ? '🥇' : rank === 2 ? '🥈' : '🥉'}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground font-medium tabular-nums">
                          {rank}
                        </span>
                      )}
                    </div>

                    {/* Name */}
                    <div className="flex items-center gap-2 min-w-0">
                      <div className={cn(
                        "shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold",
                        member.isCurrentUser
                          ? "bg-indigo-500 text-white"
                          : "bg-muted text-muted-foreground"
                      )}>
                        {member.name[0]}
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className={cn(
                          "text-[13px] truncate block",
                          member.isCurrentUser && "font-semibold"
                        )}>
                          {member.name}
                          {member.isCurrentUser && (
                            <span className="ml-1.5 text-[10px] font-medium text-indigo-500 bg-indigo-500/10 px-1.5 py-0.5 rounded-full">
                              {t('settings.leaderboard.you', 'You')}
                            </span>
                          )}
                        </span>
                      </div>
                    </div>

                    {/* Token Rank */}
                    <RankCell rank={member.tokenRank} />

                    {/* Feedback Rank */}
                    <RankCell rank={member.feedbackRank} />

                    {/* Skill Rank */}
                    <RankCell rank={member.skillRank} />

                    {/* Total Tokens */}
                    <div className="text-right">
                      <span className="text-[13px] font-medium tabular-nums">
                        {formatTokens(member.totalTokens)}
                      </span>
                      <div className="text-[10px] text-muted-foreground">
                        {member.totalFeedbacks} {t('settings.leaderboard.feedbacks', 'feedbacks')}
                        {' · '}
                        {t('settings.leaderboard.totalSkills', { count: member.totalSkillInvocations, defaultValue: '{{count}} skills' })}
                      </div>
                    </div>
                  </div>
                )
              })}
          </div>

          {/* Column legend */}
          <div className="flex items-center justify-center gap-6 text-[11px] text-muted-foreground">
            {[
              { key: 'token', label: t('settings.leaderboard.tokenUsage', 'Token Usage'), icon: Flame, color: 'text-amber-500' },
              { key: 'feedback', label: t('settings.leaderboard.feedbackCount', 'Feedback Count'), icon: MessageSquareHeart, color: 'text-pink-500' },
              { key: 'skill', label: t('settings.leaderboard.skillInvocations', 'Skill Invocations'), icon: Sparkles, color: 'text-violet-500' },
            ].map((col) => {
              const Icon = col.icon
              return (
                <div key={col.key} className="flex items-center gap-1.5">
                  <Icon className={cn("h-3 w-3", col.color)} />
                  <span>{col.label}</span>
                </div>
              )
            })}
          </div>

          {/* Top skills this team */}
          {topSkills.length > 0 && (
            <div className="rounded-xl border bg-card overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-2.5 bg-muted/30 border-b">
                <Sparkles className="h-3.5 w-3.5 text-violet-500" />
                <span className="text-xs font-medium">
                  {t('settings.leaderboard.topSkills', 'Top Skills This Team')}
                </span>
              </div>
              {topSkills.map((skill, idx) => (
                <div
                  key={skill.name}
                  className="grid grid-cols-[40px_1fr_100px_120px] items-center gap-2 px-4 py-2.5 border-b last:border-b-0"
                >
                  <span className="text-xs text-muted-foreground font-medium tabular-nums text-center">
                    {idx + 1}
                  </span>
                  <span className="text-[13px] truncate">{skill.name}</span>
                  <span className="text-xs text-right tabular-nums">
                    {skill.count} {t('settings.leaderboard.calls', 'calls')}
                  </span>
                  <span className="text-xs text-right text-muted-foreground tabular-nums">
                    {t('settings.leaderboard.usedBy', { n: skill.userCount, defaultValue: '{{n}} members' })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Pure helpers ────────────────────────────────────────────────────────

export function computeTopSkills(
  leaderboard: TeamLeaderboard,
  limit: number,
): Array<{ name: string; count: number; userCount: number }> {
  const totals = new Map<string, { count: number; users: Set<string> }>()
  for (const member of leaderboard.members || []) {
    for (const ws of Object.values(member.workspaces || {})) {
      for (const [name, n] of Object.entries(ws.skillUsage || {})) {
        const entry = totals.get(name) ?? { count: 0, users: new Set<string>() }
        entry.count += n
        entry.users.add(member.memberName)
        totals.set(name, entry)
      }
    }
  }
  return [...totals.entries()]
    .map(([name, { count, users }]) => ({ name, count, userCount: users.size }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit)
}

// ── Helpers ─────────────────────────────────────────────────────────────

function RankCell({ rank }: { rank: number | undefined }) {
  const safeRank = rank ?? 0
  return (
    <div className="flex justify-center">
      <span className={cn(
        "inline-flex items-center justify-center min-w-[20px] h-5 text-[11px] font-medium tabular-nums rounded-md px-1",
        safeRank === 1
          ? "bg-amber-500/15 text-amber-600"
          : safeRank <= 3
            ? "bg-muted text-foreground"
            : "text-muted-foreground"
      )}>
        {safeRank}
      </span>
    </div>
  )
}
