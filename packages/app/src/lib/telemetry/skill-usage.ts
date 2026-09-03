/**
 * Report a skill invocation to the cloud, which is what fills the skill
 * dimension of the team leaderboard.
 *
 * Extracted from the deleted local-stats store: skill usage used to be counted
 * into a per-workspace stats file and mirrored here. The local half is gone
 * (nothing ever read it — the leaderboard has been cloud-sourced since it moved
 * to the `team_leaderboard` view), so this is now the only reporting path.
 *
 * Best-effort by design: called from the live-event path, where a telemetry
 * failure must never disturb the stream.
 */
export async function reportSkillUsage(skillName: string): Promise<void> {
  if (!skillName) return
  try {
    const { useCurrentTeamStore } = await import('@/stores/current-team')
    const teamId = useCurrentTeamStore.getState().team?.id
    if (!teamId) return
    const { useAuthStore } = await import('@/stores/auth-store')
    const userId = useAuthStore.getState().session?.user?.id
    if (!userId) return
    const { resolveCurrentMemberActorId } = await import('@/lib/actor/current-actor')
    const actorId = await resolveCurrentMemberActorId(teamId, userId)
    if (!actorId) return
    const { getBackend } = await import('@/lib/backend')
    await getBackend().telemetry.insertSkillUsage({ actorId, teamId, skill: skillName, count: 1 })
  } catch (err) {
    console.error('[telemetry] Failed to report skill usage to cloud:', err)
  }
}
