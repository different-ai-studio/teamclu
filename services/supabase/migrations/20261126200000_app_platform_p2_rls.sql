-- App platform P2.3 — row security on apps and their tables reads the platform
-- model.
--
-- docs/specs/2026-11-25-app-platform-p2-de-team.md §3 (P2.3).
--
-- Every policy below used to ask "which actor is the caller in this app's
-- team" (amux.current_actor_id_for_team). They now ask the platform:
--
--   see an app            amux.caller_apps(): a level on it (the rule of
--                         amux.caller_app_access, 20261126100000), or an org
--                         grant on it while a member of that org
--   update an app row     the creator (by account), inside the app's org
--   read its env / cron   any level on it
--   manage env / cron /   the creator, as before
--   grants
--   read grant rows       your own rows, or every row as the creator
--
-- On the data as it stands, everything the old policies let through the new
-- ones also let through (team visibility became an org grant, the creating
-- actor became the creating account, grants and agent inheritance became user
-- grants and delegations). The one widening is decided (§6 Q4): a team-visible
-- app is now visible to its whole org, not only its team.
--
-- INSERT on apps is unchanged: rows are still written in the legacy shape
-- (team_id, created_by_actor_id) until P3, and P2.1's triggers project them.
--
-- Rolling back is re-running the previous definitions, which are DDL only;
-- see the end of this file.

-- ── what the caller sees, once per statement ────────────────────────────────
--
-- amux.caller_apps(): every app the caller sees, with their level on it — the
-- same answer as caller_app_access (20261126100000) for each app, plus the
-- apps seen only through an org grant (level null). Policies ask
-- `id in (select app_id from amux.caller_apps())`, an uncorrelated subquery
-- the planner runs once per statement, instead of a per-row function call
-- that re-checks org membership and re-reads the app for every row. Measured
-- on self-host, the per-row form cost ~2.5 ms an app (a list of 65: 160 ms).
--
-- caller_app_access stays the per-app answer the Cloud API asks for one app;
-- the P2.3 pgTAP test holds the two to the same result on every fixture pair.

create or replace function amux.caller_apps()
returns table (app_id uuid, level text, delegated boolean, is_creator boolean)
language sql
stable
security definer
set search_path = amux, public, auth
as $$
  with me as (
    select auth.uid() as uid
  ),
  -- the tenant: orgs the caller is a member of (an actor in any team there)
  orgs as (
    select distinct t.oid
      from me
      join amux.actors x on x.user_id = me.uid
      join amux.teams t on t.id = x.team_id
  ),
  -- whose level the caller acts at: their own, and each delegator's
  principals as (
    select me.uid as principal, false as via from me where me.uid is not null
    union all
    select d.principal_user_id, true
      from me
      join amux.app_delegations d on d.delegate_user_id = me.uid
  ),
  ranks as (
    select a.id, p.via, 3 as r
      from amux.apps a
      join orgs o on o.oid = a.org_id
      join principals p on p.principal = a.created_by_user_id
    union all
    select a.id, p.via,
           case g.level when 'admin' then 3 when 'write' then 2 when 'read' then 1 end
      from amux.app_grants g
      join principals p on p.principal = g.principal_user_id
      join amux.apps a on a.id = g.app_id
      join orgs o on o.oid = a.org_id
  ),
  leveled as (
    select id,
           coalesce(max(r) filter (where not via), 0) as d,
           coalesce(max(r) filter (where via), 0) as v
      from ranks
     group by id
  ),
  org_seen as (
    select distinct g.app_id as id
      from amux.app_grants g
      join amux.apps a on a.id = g.app_id and g.principal_org_id = a.org_id
      join orgs o on o.oid = a.org_id
  )
  select coalesce(l.id, s.id),
         case greatest(l.d, l.v) when 3 then 'admin' when 2 then 'write' when 1 then 'read' end,
         coalesce(l.v > l.d, false),
         coalesce(a.created_by_user_id = me.uid, false)
    from leveled l
    full join org_seen s on s.id = l.id
    join amux.apps a on a.id = coalesce(l.id, s.id)
    cross join me
$$;

comment on function amux.caller_apps() is
  'Every app the caller sees and their level on it (null = through an org grant only). Per app the same answer as caller_app_access; evaluated once per statement by the P2.3 policies.';

revoke all on function amux.caller_apps() from public, anon;
grant execute on function amux.caller_apps() to authenticated, service_role;

-- caller_app_access looks delegations up by delegate.
create index if not exists app_delegations_delegate_idx on amux.app_delegations (delegate_user_id);

-- ── apps ────────────────────────────────────────────────────────────────────

drop policy if exists apps_select_if_visible on amux.apps;
create policy apps_select_if_visible on amux.apps
  for select to authenticated
  using (id in (select app_id from amux.caller_apps()));

drop policy if exists apps_update_if_creator on amux.apps;
create policy apps_update_if_creator on amux.apps
  for update to authenticated
  using (id in (select app_id from amux.caller_apps() where is_creator))
  with check (id in (select app_id from amux.caller_apps() where is_creator));

-- ── env vars, cron ──────────────────────────────────────────────────────────

drop policy if exists app_env_vars_select on amux.app_env_vars;
create policy app_env_vars_select on amux.app_env_vars
  for select to authenticated
  using (app_id in (select app_id from amux.caller_apps() where level is not null));

drop policy if exists app_env_vars_manage on amux.app_env_vars;
create policy app_env_vars_manage on amux.app_env_vars
  for all to authenticated
  using (app_id in (select app_id from amux.caller_apps() where is_creator))
  with check (app_id in (select app_id from amux.caller_apps() where is_creator));

drop policy if exists app_cron_jobs_select on amux.app_cron_jobs;
create policy app_cron_jobs_select on amux.app_cron_jobs
  for select to authenticated
  using (app_id in (select app_id from amux.caller_apps() where level is not null));

drop policy if exists app_cron_jobs_manage on amux.app_cron_jobs;
create policy app_cron_jobs_manage on amux.app_cron_jobs
  for all to authenticated
  using (app_id in (select app_id from amux.caller_apps() where is_creator))
  with check (app_id in (select app_id from amux.caller_apps() where is_creator));

drop policy if exists app_cron_runs_select on amux.app_cron_runs;
create policy app_cron_runs_select on amux.app_cron_runs
  for select to authenticated
  using (app_id in (select app_id from amux.caller_apps() where level is not null));

-- ── grants ──────────────────────────────────────────────────────────────────

drop policy if exists app_member_access_select on amux.app_member_access;
create policy app_member_access_select on amux.app_member_access
  for select to authenticated
  using (
    exists (select 1 from amux.actors x where x.id = member_id and x.user_id = auth.uid())
    or app_id in (select app_id from amux.caller_apps() where is_creator)
  );

drop policy if exists app_member_access_manage on amux.app_member_access;
create policy app_member_access_manage on amux.app_member_access
  for all to authenticated
  using (app_id in (select app_id from amux.caller_apps() where is_creator))
  with check (app_id in (select app_id from amux.caller_apps() where is_creator));

-- ── rollback (for reference; not executed) ──────────────────────────────────
--
-- The previous definitions, as they stood after 20261120120000:
--
--   apps_select_if_visible  using (amux.is_team_member(team_id) and (visibility = 'team'
--                             or created_by_actor_id = amux.current_actor_id_for_team(team_id)
--                             or amux.actor_has_app_access(id, amux.current_actor_id_for_team(team_id))))
--   apps_update_if_creator  using / check (created_by_actor_id = amux.current_actor_id_for_team(team_id))
--   app_{env_vars,cron_jobs,cron_runs}_select
--                           using (exists (select 1 from amux.apps a where a.id = app_id
--                             and a.created_by_actor_id = amux.current_actor_id_for_team(a.team_id))
--                             or amux.caller_has_app_grant(app_id))
--   app_{env_vars,cron_jobs,member_access}_manage
--                           using / check (exists (select 1 from amux.apps a where a.id = app_id
--                             and a.created_by_actor_id = amux.current_actor_id_for_team(a.team_id)))
--   app_member_access_select
--                           using (member_id = (select amux.current_actor_id_for_team(a.team_id)
--                             from amux.apps a where a.id = app_id)
--                             or exists (select 1 from amux.apps a where a.id = app_id
--                             and a.created_by_actor_id = amux.current_actor_id_for_team(a.team_id)))
--
-- The functions they call are left in place until P3.
