-- App platform P2.3 — row security on apps and their tables reads the platform
-- model.
--
-- docs/specs/2026-11-25-app-platform-p2-de-team.md §3 (P2.3).
--
-- Every policy below used to ask "which actor is the caller in this app's
-- team" (amux.current_actor_id_for_team). They now ask the platform:
--
--   see an app            amux.caller_sees_app: a level on it
--                         (amux.caller_app_access, 20261126100000), or an org
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

-- ── who sees an app ─────────────────────────────────────────────────────────

create or replace function amux.caller_sees_app(p_app_id uuid)
returns boolean
language sql
stable
security definer
set search_path = amux, public, auth
as $$
  select exists (select 1 from amux.caller_app_access(p_app_id))
      or exists (
        select 1
          from amux.apps a
          join amux.app_grants g on g.app_id = a.id and g.principal_org_id = a.org_id
         where a.id = p_app_id
           and auth.uid() is not null
           and exists (
             select 1
               from amux.actors x
               join amux.teams t on t.id = x.team_id
              where x.user_id = auth.uid()
                and t.oid = a.org_id
           )
      )
$$;

comment on function amux.caller_sees_app(uuid) is
  'Whether the caller may see an app: a level on it (caller_app_access), or an org grant on it while a member of that org. P2.3.';

revoke all on function amux.caller_sees_app(uuid) from public, anon;
grant execute on function amux.caller_sees_app(uuid) to authenticated, service_role;

-- caller_app_access looks delegations up by delegate.
create index if not exists app_delegations_delegate_idx on amux.app_delegations (delegate_user_id);

-- ── apps ────────────────────────────────────────────────────────────────────

drop policy if exists apps_select_if_visible on amux.apps;
create policy apps_select_if_visible on amux.apps
  for select to authenticated
  using (amux.caller_sees_app(id));

drop policy if exists apps_update_if_creator on amux.apps;
create policy apps_update_if_creator on amux.apps
  for update to authenticated
  using (exists (select 1 from amux.caller_app_access(id) where is_creator))
  with check (exists (select 1 from amux.caller_app_access(id) where is_creator));

-- ── env vars, cron ──────────────────────────────────────────────────────────

drop policy if exists app_env_vars_select on amux.app_env_vars;
create policy app_env_vars_select on amux.app_env_vars
  for select to authenticated
  using (exists (select 1 from amux.caller_app_access(app_id)));

drop policy if exists app_env_vars_manage on amux.app_env_vars;
create policy app_env_vars_manage on amux.app_env_vars
  for all to authenticated
  using (exists (select 1 from amux.caller_app_access(app_id) where is_creator))
  with check (exists (select 1 from amux.caller_app_access(app_id) where is_creator));

drop policy if exists app_cron_jobs_select on amux.app_cron_jobs;
create policy app_cron_jobs_select on amux.app_cron_jobs
  for select to authenticated
  using (exists (select 1 from amux.caller_app_access(app_id)));

drop policy if exists app_cron_jobs_manage on amux.app_cron_jobs;
create policy app_cron_jobs_manage on amux.app_cron_jobs
  for all to authenticated
  using (exists (select 1 from amux.caller_app_access(app_id) where is_creator))
  with check (exists (select 1 from amux.caller_app_access(app_id) where is_creator));

drop policy if exists app_cron_runs_select on amux.app_cron_runs;
create policy app_cron_runs_select on amux.app_cron_runs
  for select to authenticated
  using (exists (select 1 from amux.caller_app_access(app_id)));

-- ── grants ──────────────────────────────────────────────────────────────────

drop policy if exists app_member_access_select on amux.app_member_access;
create policy app_member_access_select on amux.app_member_access
  for select to authenticated
  using (
    exists (select 1 from amux.actors x where x.id = member_id and x.user_id = auth.uid())
    or exists (select 1 from amux.caller_app_access(app_id) where is_creator)
  );

drop policy if exists app_member_access_manage on amux.app_member_access;
create policy app_member_access_manage on amux.app_member_access
  for all to authenticated
  using (exists (select 1 from amux.caller_app_access(app_id) where is_creator))
  with check (exists (select 1 from amux.caller_app_access(app_id) where is_creator));

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
