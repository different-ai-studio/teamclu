-- App platform P2.1 — expand: the platform's own identity model, beside the old one.
--
-- docs/specs/2026-11-25-app-platform-p2-de-team.md. The platform is moving to
-- org (tenant) + auth.users (principal). This migration only ADDS:
--
--   amux.app_links          TeamClu's link of an app to its team, workspace and creator actor
--   amux.app_grants         who holds what on an app: a user, or a whole org (read/write only)
--   amux.app_delegations    a user acting at another user's level (an agent for its owner)
--   apps.created_by_user_id, app_cron_jobs.created_by_user_id, app_env_vars.updated_by_user_id
--
-- Nothing reads the new objects yet, and nothing old changes: the existing
-- tables stay the source of truth and the Cloud API keeps writing them. The new
-- ones are a projection kept in step by the triggers below, inside the same
-- transaction as the write that causes them. Rolling the Cloud API back is
-- therefore always safe, and P2.2 can switch reads over knowing the projection
-- is complete. The triggers and the old columns go together in P3.
--
-- Rows the projection owns are marked so later native writes are never
-- touched by it:
--   app_grants.legacy_member_id      the app_member_access grantee (or null for
--                                    the org grant from visibility='team')
--   app_grants.source                'legacy' | 'native'
--   app_delegations.source_agent_id  the amux.agents row it came from
-- Both reference the old rows with ON DELETE CASCADE, so removing an actor or an
-- agent clears its projected rows without any lookup.

-- ── 1. the new columns ─────────────────────────────────────────────────────

alter table amux.apps
  add column if not exists created_by_user_id uuid references auth.users(id) on delete set null;
create index if not exists apps_created_by_user_idx on amux.apps (created_by_user_id);

alter table amux.app_cron_jobs
  add column if not exists created_by_user_id uuid references auth.users(id) on delete set null;
alter table amux.app_env_vars
  add column if not exists updated_by_user_id uuid references auth.users(id) on delete set null;

comment on column amux.apps.created_by_user_id is
  'The account that created the app (a person or an agent''s account). For an agent with no account of its own, its owner. Kept from created_by_actor_id until P3.';

-- ── 2. app_links (TeamClu) ─────────────────────────────────────────────────

create table if not exists amux.app_links (
  app_id              uuid primary key references amux.apps(id) on delete cascade,
  team_id             uuid not null references amux.teams(id) on delete cascade,
  workspace_id        uuid unique references amux.workspaces(id) on delete set null,
  -- NO ACTION, not RESTRICT: checked at the end of the statement, so a team
  -- delete that cascades the actor and this row together is not refused.
  created_by_actor_id uuid not null references amux.actors(id),
  created_at          timestamptz not null default now()
);
create index if not exists app_links_team_idx on amux.app_links (team_id);
create index if not exists app_links_creator_idx on amux.app_links (created_by_actor_id);

comment on table amux.app_links is
  'TeamClu''s association of an app with a team, its workspace and the actor that created it. The app platform does not read it.';

-- ── 3. app_grants (platform) ───────────────────────────────────────────────

create table if not exists amux.app_grants (
  id                 uuid primary key default gen_random_uuid(),
  app_id             uuid not null references amux.apps(id) on delete cascade,
  principal_user_id  uuid references auth.users(id) on delete cascade,
  principal_org_id   uuid references public.orgs(id) on delete cascade,
  level              text not null check (level in ('read', 'write', 'admin')),
  granted_by_user_id uuid references auth.users(id) on delete set null,
  source             text not null default 'native' check (source in ('native', 'legacy')),
  legacy_member_id   uuid references amux.actors(id) on delete cascade,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint app_grants_one_principal check (num_nonnulls(principal_user_id, principal_org_id) = 1),
  constraint app_grants_org_level check (principal_org_id is null or level in ('read', 'write')),
  constraint app_grants_legacy_shape check (source = 'native' or legacy_member_id is not null or principal_org_id is not null)
);
create unique index if not exists app_grants_user_uniq
  on amux.app_grants (app_id, principal_user_id) where principal_user_id is not null;
create unique index if not exists app_grants_org_uniq
  on amux.app_grants (app_id, principal_org_id) where principal_org_id is not null;
create index if not exists app_grants_principal_user_idx on amux.app_grants (principal_user_id);
create index if not exists app_grants_legacy_member_idx on amux.app_grants (legacy_member_id);

comment on table amux.app_grants is
  'App platform grants: a user, or a whole org (read/write), at read/write/admin. source=legacy rows mirror app_member_access and visibility=team until P3.';

-- ── 4. app_delegations (platform) ──────────────────────────────────────────

create table if not exists amux.app_delegations (
  id                uuid primary key default gen_random_uuid(),
  delegate_user_id  uuid not null references auth.users(id) on delete cascade,
  principal_user_id uuid not null references auth.users(id) on delete cascade,
  source_agent_id   uuid references amux.agents(id) on delete cascade,
  created_at        timestamptz not null default now(),
  constraint app_delegations_not_self check (delegate_user_id <> principal_user_id)
);
create unique index if not exists app_delegations_native_uniq
  on amux.app_delegations (delegate_user_id, principal_user_id) where source_agent_id is null;
create unique index if not exists app_delegations_agent_uniq
  on amux.app_delegations (source_agent_id) where source_agent_id is not null;
create index if not exists app_delegations_principal_idx on amux.app_delegations (principal_user_id);

comment on table amux.app_delegations is
  'The delegate acts on apps at the principal''s level — up to deploy, never managing access or deleting an app (P2 Q1). source_agent_id rows mirror active agents and their owners until P3.';

-- ── 5. access: service role only until P2.3 writes the policies ────────────

alter table amux.app_links enable row level security;
alter table amux.app_grants enable row level security;
alter table amux.app_delegations enable row level security;
revoke all on amux.app_links, amux.app_grants, amux.app_delegations from anon, authenticated;
grant all on amux.app_links, amux.app_grants, amux.app_delegations to service_role;

-- ── 6. projection helpers ──────────────────────────────────────────────────

-- The account behind an app's creator: the actor's own user, or — for an agent
-- with no account — its owner's (P2 Q5).
create or replace function amux.app_creator_user_id(p_actor_id uuid)
returns uuid
language sql
stable
security definer
set search_path to 'amux', 'public'
as $$
  select coalesce(a.user_id, o.user_id)
    from amux.actors a
    left join amux.agents g on g.id = a.id
    left join amux.actors o on o.id = g.owner_member_id
   where a.id = p_actor_id;
$$;

-- A grant level as the platform names it. app_member_access used view/prompt
-- before 20261117000000 renamed them; map them the same way, so the projection
-- never depends on which side of that rename a row was written.
create or replace function amux.app_grant_level(p_level text)
returns text
language sql
immutable
as $$
  select case p_level when 'view' then 'read' when 'prompt' then 'write' else p_level end;
$$;

-- Rebuild the legacy grant rows of one grantee actor from app_member_access.
-- Never called on a delete path: those are covered by ON DELETE CASCADE.
create or replace function amux.app_project_member_grants(p_member_id uuid)
returns void
language plpgsql
security definer
set search_path to 'amux', 'public'
as $$
begin
  delete from amux.app_grants where legacy_member_id = p_member_id;
  insert into amux.app_grants (app_id, principal_user_id, level, granted_by_user_id, source,
                               legacy_member_id, created_at, updated_at)
  select m.app_id, ac.user_id, amux.app_grant_level(m.permission_level), gb.user_id, 'legacy', m.member_id, m.created_at, m.updated_at
    from amux.app_member_access m
    join amux.actors ac on ac.id = m.member_id
    left join amux.actors gb on gb.id = m.granted_by_member_id
   where m.member_id = p_member_id
     and ac.user_id is not null
  on conflict do nothing;  -- a native grant to the same user wins
end;
$$;

-- Rebuild the legacy delegation of one agent.
create or replace function amux.app_project_agent_delegation(p_agent_id uuid)
returns void
language plpgsql
security definer
set search_path to 'amux', 'public'
as $$
begin
  delete from amux.app_delegations where source_agent_id = p_agent_id;
  insert into amux.app_delegations (delegate_user_id, principal_user_id, source_agent_id)
  select ag.user_id, o.user_id, g.id
    from amux.agents g
    join amux.actors ag on ag.id = g.id
    join amux.actors o on o.id = g.owner_member_id
   where g.id = p_agent_id
     and g.status = 'active'
     and ag.user_id is not null
     and o.user_id is not null
     and ag.user_id <> o.user_id;
end;
$$;

revoke all on function amux.app_creator_user_id(uuid) from public;
revoke all on function amux.app_project_member_grants(uuid) from public;
revoke all on function amux.app_project_agent_delegation(uuid) from public;
grant execute on function amux.app_creator_user_id(uuid) to service_role;
grant execute on function amux.app_project_member_grants(uuid) to service_role;
grant execute on function amux.app_project_agent_delegation(uuid) to service_role;

-- ── 7. triggers: keep the projection in step ───────────────────────────────

-- apps BEFORE: created_by_user_id follows created_by_actor_id.
create or replace function amux.trg_apps_creator_user()
returns trigger
language plpgsql
security definer
set search_path to 'amux', 'public'
as $$
begin
  if tg_op = 'INSERT' or new.created_by_actor_id is distinct from old.created_by_actor_id then
    new.created_by_user_id := coalesce(
      case when tg_op = 'INSERT' then new.created_by_user_id end,
      amux.app_creator_user_id(new.created_by_actor_id));
  end if;
  return new;
end;
$$;
drop trigger if exists apps_creator_user on amux.apps;
create trigger apps_creator_user
  before insert or update of created_by_actor_id on amux.apps
  for each row execute function amux.trg_apps_creator_user();

-- apps AFTER: the link, and the org grant that visibility='team' means.
create or replace function amux.trg_apps_project()
returns trigger
language plpgsql
security definer
set search_path to 'amux', 'public'
as $$
begin
  insert into amux.app_links (app_id, team_id, workspace_id, created_by_actor_id)
  values (new.id, new.team_id, new.workspace_id, new.created_by_actor_id)
  on conflict (app_id) do update
     set team_id = excluded.team_id,
         workspace_id = excluded.workspace_id,
         created_by_actor_id = excluded.created_by_actor_id;

  if tg_op = 'UPDATE' and new.org_id is distinct from old.org_id then
    delete from amux.app_grants
     where app_id = new.id and source = 'legacy' and principal_org_id = old.org_id;
  end if;
  if new.visibility = 'team' then
    insert into amux.app_grants (app_id, principal_org_id, level, source)
    values (new.id, new.org_id, 'read', 'legacy')
    on conflict do nothing;
  elsif tg_op = 'UPDATE' then
    delete from amux.app_grants
     where app_id = new.id and source = 'legacy' and principal_org_id is not null;
  end if;
  return null;
end;
$$;
drop trigger if exists apps_project on amux.apps;
create trigger apps_project
  after insert or update of team_id, workspace_id, created_by_actor_id, visibility, org_id on amux.apps
  for each row execute function amux.trg_apps_project();

-- app_member_access AFTER INSERT/UPDATE: re-project the grantee (and the old
-- one, if the row moved). Deletes need nothing: the projected row goes with it.
create or replace function amux.trg_app_member_access_project()
returns trigger
language plpgsql
security definer
set search_path to 'amux', 'public'
as $$
begin
  if tg_op = 'UPDATE' and new.member_id is distinct from old.member_id then
    perform amux.app_project_member_grants(old.member_id);
  end if;
  perform amux.app_project_member_grants(new.member_id);
  return null;
end;
$$;
drop trigger if exists app_member_access_project on amux.app_member_access;
create trigger app_member_access_project
  after insert or update on amux.app_member_access
  for each row execute function amux.trg_app_member_access_project();

-- app_member_access AFTER DELETE: drop that one projected row. The cascade
-- from app_grants.legacy_member_id covers an actor going away; this covers a
-- grant revoked while its actor stays.
create or replace function amux.trg_app_member_access_unproject()
returns trigger
language plpgsql
security definer
set search_path to 'amux', 'public'
as $$
begin
  delete from amux.app_grants
   where app_id = old.app_id and legacy_member_id = old.member_id;
  return null;
end;
$$;
drop trigger if exists app_member_access_unproject on amux.app_member_access;
create trigger app_member_access_unproject
  after delete on amux.app_member_access
  for each row execute function amux.trg_app_member_access_unproject();

-- agents AFTER INSERT/UPDATE: the delegation follows status and owner.
create or replace function amux.trg_agents_project()
returns trigger
language plpgsql
security definer
set search_path to 'amux', 'public'
as $$
begin
  perform amux.app_project_agent_delegation(new.id);
  return null;
end;
$$;
drop trigger if exists agents_project_delegation on amux.agents;
create trigger agents_project_delegation
  after insert or update of status, owner_member_id on amux.agents
  for each row execute function amux.trg_agents_project();

-- actors AFTER UPDATE OF user_id: an account linked, unlinked or swapped.
create or replace function amux.trg_actors_project()
returns trigger
language plpgsql
security definer
set search_path to 'amux', 'public'
as $$
declare
  r record;
begin
  perform amux.app_project_member_grants(new.id);
  for r in select id from amux.agents where id = new.id or owner_member_id = new.id loop
    perform amux.app_project_agent_delegation(r.id);
  end loop;
  update amux.apps
     set created_by_user_id = amux.app_creator_user_id(created_by_actor_id)
   where created_by_actor_id = new.id
      or created_by_actor_id in (select id from amux.agents where owner_member_id = new.id);
  return null;
end;
$$;
drop trigger if exists actors_project_app_identity on amux.actors;
create trigger actors_project_app_identity
  after update of user_id on amux.actors
  for each row when (new.user_id is distinct from old.user_id)
  execute function amux.trg_actors_project();

-- Operator columns follow the member columns they stand beside.
create or replace function amux.trg_app_operator_user()
returns trigger
language plpgsql
security definer
set search_path to 'amux', 'public'
as $$
begin
  -- Only when a member is named: a writer that sets the user column itself
  -- (P2.2 on) is left alone.
  if tg_table_name = 'app_cron_jobs' then
    if new.created_by_member_id is not null then
      new.created_by_user_id := (select user_id from amux.actors where id = new.created_by_member_id);
    end if;
  elsif new.updated_by_member_id is not null then
    new.updated_by_user_id := (select user_id from amux.actors where id = new.updated_by_member_id);
  end if;
  return new;
end;
$$;
drop trigger if exists app_cron_jobs_operator_user on amux.app_cron_jobs;
create trigger app_cron_jobs_operator_user
  before insert or update of created_by_member_id on amux.app_cron_jobs
  for each row execute function amux.trg_app_operator_user();
drop trigger if exists app_env_vars_operator_user on amux.app_env_vars;
create trigger app_env_vars_operator_user
  before insert or update of updated_by_member_id on amux.app_env_vars
  for each row execute function amux.trg_app_operator_user();

-- ── 8. backfill (idempotent: every statement can run again) ────────────────

update amux.apps
   set created_by_user_id = amux.app_creator_user_id(created_by_actor_id)
 where created_by_user_id is null;

insert into amux.app_links (app_id, team_id, workspace_id, created_by_actor_id)
select id, team_id, workspace_id, created_by_actor_id from amux.apps
on conflict (app_id) do nothing;

insert into amux.app_grants (app_id, principal_user_id, level, granted_by_user_id, source,
                             legacy_member_id, created_at, updated_at)
select m.app_id, ac.user_id, amux.app_grant_level(m.permission_level), gb.user_id, 'legacy', m.member_id, m.created_at, m.updated_at
  from amux.app_member_access m
  join amux.actors ac on ac.id = m.member_id
  left join amux.actors gb on gb.id = m.granted_by_member_id
 where ac.user_id is not null
on conflict do nothing;

insert into amux.app_grants (app_id, principal_org_id, level, source)
select id, org_id, 'read', 'legacy' from amux.apps where visibility = 'team'
on conflict do nothing;

insert into amux.app_delegations (delegate_user_id, principal_user_id, source_agent_id)
select ag.user_id, o.user_id, g.id
  from amux.agents g
  join amux.actors ag on ag.id = g.id
  join amux.actors o on o.id = g.owner_member_id
 where g.status = 'active'
   and ag.user_id is not null
   and o.user_id is not null
   and ag.user_id <> o.user_id
on conflict do nothing;

update amux.app_cron_jobs j
   set created_by_user_id = a.user_id
  from amux.actors a
 where a.id = j.created_by_member_id and j.created_by_user_id is null;

update amux.app_env_vars e
   set updated_by_user_id = a.user_id
  from amux.actors a
 where a.id = e.updated_by_member_id and e.updated_by_user_id is null;
