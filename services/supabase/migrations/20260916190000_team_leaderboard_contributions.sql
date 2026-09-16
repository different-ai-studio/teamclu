-- Leaderboard contributions: how many team skills each member has published and
-- how many apps they have created.
--
-- A separate function rather than two more columns on team_leaderboard, for
-- two reasons:
--
--   1. It has to be SECURITY DEFINER. team_leaderboard is plain STABLE SQL so
--      RLS decides what it aggregates, which is fine for reports and feedback
--      (every member reads the whole team). amux.apps is not like that:
--      apps_select_if_visible hides another member's personal apps, and
--      personal is the default visibility. Counted under the caller's rights,
--      every viewer would see a different app count for everyone else. Only a
--      count leaves this function, never an app row.
--   2. Adding columns to team_leaderboard means DROP + CREATE (the RETURNS
--      TABLE changes), which breaks a Cloud API build still calling the old
--      shape during a deploy. A new function is additive; FC treats it being
--      absent as zero contributions.
--
-- Counting rules:
--   * a skill counts once it has left draft ('published' or 'deprecated'),
--     credited to created_by (the publisher), not owner_actor_id (whoever it
--     was handed to later);
--   * an app counts from creation, whatever its provision status;
--   * both are all-time, not windowed by the leaderboard period: they are
--     things a member has built, not activity in a week;
--   * an agent's work is credited to agents.owner_member_id, the same roll-up
--     the credit-usage report uses, so a skill a member's daemon published
--     lands on the member's row.
--
-- A caller who is not in the team gets no rows.
--
-- Idempotent: CREATE OR REPLACE, safe for self-host's apply loop.

create or replace function amux.team_leaderboard_contributions(p_team_id uuid)
returns table (actor_id uuid, skills_published bigint, apps_created bigint)
language sql
stable
security definer
set search_path to 'amux', 'public', 'auth'
as $$
  with created as (
    select s.created_by as creator, 'skill'::text as kind
      from amux.team_skills s
     where s.team_id = p_team_id
       and s.status <> 'draft'
       and s.created_by is not null
    union all
    select ap.created_by_actor_id, 'app'
      from amux.apps ap
     where ap.team_id = p_team_id
  )
  select coalesce(ag.owner_member_id, c.creator)            as actor_id,
         count(*) filter (where c.kind = 'skill')::bigint    as skills_published,
         count(*) filter (where c.kind = 'app')::bigint      as apps_created
    from created c
    left join amux.agents ag on ag.id = c.creator
   where amux.is_team_member(p_team_id)
   group by 1;
$$;

revoke all on function amux.team_leaderboard_contributions(uuid) from public;
grant execute on function amux.team_leaderboard_contributions(uuid) to authenticated;
