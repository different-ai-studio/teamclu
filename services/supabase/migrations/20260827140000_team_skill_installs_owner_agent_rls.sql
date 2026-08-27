-- team_skill_installs: allow a member to record installs onto their own agent.
--
-- The FC application gate (assertCanInstallTeamSkillFor in
-- services/fc/src/lib/supabase-repo.ts and pg-repo/team-skills.ts) has three
-- allowed targets:
--   1. the caller's own member actor
--   2. an agent the caller owns (owner_member_id = caller) — any visibility
--   3. a visibility='team' agent, team admin only
--
-- The RLS policy only knew (1) and (3). Publishing or installing from the
-- desktop with the local device agent selected as the subject hits (2): FC
-- forwards the member's JWT to PostgREST with actor_id = <their own agent>,
-- and Postgres answered
--   new row violates row-level security policy for table "team_skill_installs"
-- while the version itself had already published.
--
-- This adds branch (2) to both USING and WITH CHECK (the policy is FOR ALL,
-- so both halves need it). Nothing loosens for other members' actors or
-- other people's private agents.
--
-- Idempotent: safe for the self-host apply-migrations loop to re-run.

drop policy if exists team_skill_installs_write_self_or_team_agent on amux.team_skill_installs;
create policy team_skill_installs_write_self_or_team_agent on amux.team_skill_installs
  for all using (
    amux.is_team_member(team_id)
    and (
      actor_id = amux.current_actor_id_for_team(team_id)
      or exists (
        select 1 from amux.agents ag
        where ag.id = actor_id
          and ag.owner_member_id = amux.current_actor_id_for_team(team_id)
      )
      or (
        amux.is_team_admin_or_owner(team_id)
        and exists (
          select 1 from amux.agents ag
          where ag.id = actor_id and ag.visibility = 'team'
        )
      )
    )
  ) with check (
    amux.is_team_member(team_id)
    and (
      actor_id = amux.current_actor_id_for_team(team_id)
      or exists (
        select 1 from amux.agents ag
        where ag.id = actor_id
          and ag.owner_member_id = amux.current_actor_id_for_team(team_id)
      )
      or (
        amux.is_team_admin_or_owner(team_id)
        and exists (
          select 1 from amux.agents ag
          where ag.id = actor_id and ag.visibility = 'team'
        )
      )
    )
  );

