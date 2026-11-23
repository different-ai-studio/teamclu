-- App grants are held by actors, not only by members; levels match Gitea.
--
-- Two changes to amux.app_member_access, both for the per-account Gitea auth
-- (docs/specs/2026-11-16-app-platform-identity-design.md, decisions 4, 7, 10):
--
-- 1. An agent can hold a grant and can give one. Agents have their own
--    accounts and are granted access the way a person is. The grantee and
--    grantor columns referenced amux.members, which has no row for an agent
--    actor, so an agent could never be granted anything and an agent that
--    created an app (and is therefore its admin) could never grant anyone.
--    Both now reference amux.actors. The columns keep their names; a rename
--    would touch every reader for no behavioural gain.
--
-- 2. The levels are renamed to Gitea's collaborator levels, so the projection
--    onto Gitea is the identity:
--      view   -> read
--      prompt -> write
--      admin  -> admin
--    amux.agent_member_access ("who may talk to this agent") keeps
--    view/prompt/admin: there "prompt" means what it says, and it has nothing
--    to do with Gitea.
--
-- Every policy that recognised a grantee through amux.current_member_id()
-- only ever matched people. They now ask for the caller's actor in the app's
-- team, which is a member or an agent alike.

-- ── 1. Grantee and grantor are actors ──────────────────────────────────────

alter table amux.app_member_access
  drop constraint if exists app_member_access_member_id_fkey;
alter table amux.app_member_access
  add constraint app_member_access_member_id_fkey
  foreign key (member_id) references amux.actors(id) on delete cascade;

alter table amux.app_member_access
  drop constraint if exists app_member_access_granted_by_member_id_fkey;
alter table amux.app_member_access
  add constraint app_member_access_granted_by_member_id_fkey
  foreign key (granted_by_member_id) references amux.actors(id) on delete set null;

comment on column amux.app_member_access.member_id is
  'The grantee: an actor (member or agent) in the app''s team. Named member_id for history; it has referenced amux.actors since 20261117000000.';
comment on column amux.app_member_access.granted_by_member_id is
  'The actor (member or agent) that gave the grant. Named for history; references amux.actors.';

-- ── 2. Levels: read / write / admin ────────────────────────────────────────

alter table amux.app_member_access
  drop constraint if exists app_member_access_permission_level_check;

update amux.app_member_access
   set permission_level = case permission_level
         when 'view'   then 'read'
         when 'prompt' then 'write'
         else permission_level
       end,
       updated_at = now()
 where permission_level in ('view', 'prompt');

alter table amux.app_member_access
  add constraint app_member_access_permission_level_check
  check (permission_level in ('read', 'write', 'admin'));

-- ── 3. A grant stays inside the app's team ─────────────────────────────────
--
-- The repository checks this before writing; the trigger is the guarantee.
-- External actors (WeCom contacts and the like) have no account to act with
-- and are never grantees.

create or replace function amux.app_member_access_same_team()
returns trigger
language plpgsql
security definer
set search_path to 'amux', 'public'
as $$
declare
  v_app_team   uuid;
  v_actor_team uuid;
  v_actor_type text;
begin
  select team_id into v_app_team from amux.apps where id = new.app_id;
  select team_id, actor_type into v_actor_team, v_actor_type
    from amux.actors where id = new.member_id;

  if v_actor_team is null or v_app_team is null or v_actor_team <> v_app_team then
    raise exception 'app grant must name an actor in the app''s team'
      using errcode = '23514';
  end if;
  if v_actor_type not in ('member', 'agent') then
    raise exception 'app grant cannot name a % actor', v_actor_type
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists app_member_access_same_team on amux.app_member_access;
create trigger app_member_access_same_team
  before insert or update of app_id, member_id on amux.app_member_access
  for each row execute function amux.app_member_access_same_team();

-- ── 4. Grantee recognition: the caller's actor in the app's team ───────────
--
-- One helper so the four policies below cannot drift. SECURITY DEFINER for the
-- same reason actor_has_app_access is: a policy on app_member_access that read
-- app_member_access under the caller's own RLS would recurse.

create or replace function amux.caller_has_app_grant(p_app_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'amux', 'public'
as $$
  select exists (
    select 1
      from amux.app_member_access ama
      join amux.apps a on a.id = ama.app_id
     where ama.app_id = p_app_id
       and ama.member_id = amux.current_actor_id_for_team(a.team_id)
  );
$$;

comment on function amux.caller_has_app_grant(uuid) is
  'True when the caller''s actor in the app''s team (a member or an agent) holds any grant on the app. RLS cannot express a level; the repository narrows to read/write/admin.';

revoke all on function amux.caller_has_app_grant(uuid) from public;
grant execute on function amux.caller_has_app_grant(uuid) to authenticated, service_role;

drop policy if exists app_member_access_select on amux.app_member_access;
create policy app_member_access_select on amux.app_member_access
for select to authenticated using (
  member_id = (
    select amux.current_actor_id_for_team(a.team_id)
      from amux.apps a
     where a.id = app_member_access.app_id
  )
  or exists (
    select 1
      from amux.apps a
     where a.id = app_member_access.app_id
       and a.created_by_actor_id = amux.current_actor_id_for_team(a.team_id)
  )
);

drop policy if exists app_cron_jobs_select on amux.app_cron_jobs;
create policy app_cron_jobs_select on amux.app_cron_jobs
for select to authenticated using (
  exists (
    select 1
      from amux.apps a
     where a.id = app_cron_jobs.app_id
       and a.created_by_actor_id = amux.current_actor_id_for_team(a.team_id)
  )
  or amux.caller_has_app_grant(app_cron_jobs.app_id)
);

drop policy if exists app_cron_runs_select on amux.app_cron_runs;
create policy app_cron_runs_select on amux.app_cron_runs
for select to authenticated using (
  exists (
    select 1
      from amux.apps a
     where a.id = app_cron_runs.app_id
       and a.created_by_actor_id = amux.current_actor_id_for_team(a.team_id)
  )
  or amux.caller_has_app_grant(app_cron_runs.app_id)
);

drop policy if exists app_env_vars_select on amux.app_env_vars;
create policy app_env_vars_select on amux.app_env_vars
for select to authenticated using (
  exists (
    select 1
      from amux.apps a
     where a.id = app_env_vars.app_id
       and a.created_by_actor_id = amux.current_actor_id_for_team(a.team_id)
  )
  or amux.caller_has_app_grant(app_env_vars.app_id)
);
