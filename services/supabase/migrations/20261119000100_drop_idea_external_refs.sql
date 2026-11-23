-- Drop amux.idea_external_refs (ideas linked to GitHub/Jira-style issues).
--
-- No code has ever read or written it outside pgTAP and the dead seed: a
-- repo-wide search of services/fc, services/ai-gateway, apps/daemon,
-- apps/desktop (incl. the local cache mirror), packages/app, apps/ios,
-- apps/expo, the browser extension, scripts/ and deploy/ finds no reference.
--
-- THIS IS A ONE-WAY DOOR ON DATA. Before applying it to a live database, run
-- (read-only):
--
--   select count(*) from amux.idea_external_refs;
--
-- The block below refuses to drop a table that still has rows, so a database
-- where somebody did use it fails this migration loudly instead of losing the
-- rows. If that happens: export the rows, decide, and either delete them or
-- withhold this file. Nothing later depends on it, so it can be withheld.
--
-- enforce_parent_integrity (latest: 20260804010000) probes this table when an
-- actor or idea changes team. plpgsql resolves tables at run time, so leaving
-- those probes in would turn every such UPDATE into 42P01 — exactly what
-- happened when agent_runtimes was dropped (see 20260804010000). It is
-- rewritten here without them, otherwise verbatim. enforce_core_team_integrity
-- keeps an `elsif tg_table_name = 'idea_external_refs'` branch; with no table
-- there is no trigger to take it, so it is dead but harmless.

do $guard$
declare
  v_rows bigint;
begin
  if to_regclass('amux.idea_external_refs') is null then
    return;
  end if;
  execute 'select count(*) from amux.idea_external_refs' into v_rows;
  if v_rows > 0 then
    raise exception
      'amux.idea_external_refs still has % row(s); export them and decide before dropping (see this migration''s header)',
      v_rows
      using errcode = 'P0001';
  end if;
end
$guard$;

create or replace function amux.enforce_parent_integrity()
returns trigger
language plpgsql
as $function$
begin
  if tg_table_name = 'actors' then
    if new.actor_type is distinct from old.actor_type then
      if exists (select 1 from amux.members where id = new.id) and new.actor_type <> 'member' then
        raise exception 'actors.actor_type cannot diverge from members.id'
          using errcode = '23514';
      end if;

      if exists (select 1 from amux.agents where id = new.id) and new.actor_type <> 'agent' then
        raise exception 'actors.actor_type cannot diverge from agents.id'
          using errcode = '23514';
      end if;
    end if;

    if new.team_id is distinct from old.team_id then
      if exists (select 1 from amux.members where id = new.id)
        or exists (select 1 from amux.agents where id = new.id)
        or exists (select 1 from amux.team_members where member_id = new.id)
        or exists (select 1 from amux.workspaces where created_by_member_id = new.id or agent_id = new.id)
        or exists (select 1 from amux.agent_member_access where member_id = new.id or granted_by_member_id = new.id or agent_id = new.id)
        or exists (select 1 from amux.ideas where created_by_actor_id = new.id)
        or exists (select 1 from amux.sessions where created_by_actor_id = new.id or primary_agent_id = new.id)
        or exists (select 1 from amux.session_participants where actor_id = new.id)
        or exists (select 1 from amux.messages where sender_actor_id = new.id) then
        perform amux.reject_team_reassignment('actors.team_id');
      end if;
    end if;
  elsif tg_table_name = 'workspaces' then
    if new.team_id is distinct from old.team_id
      and (
        exists (select 1 from amux.agents where default_workspace_id = new.id)
        or old.agent_id is not null
        or exists (select 1 from amux.ideas where workspace_id = new.id)
        or exists (select 1 from amux.session_participants where workspace_id = new.id)
      ) then
      perform amux.reject_team_reassignment('workspaces.team_id');
    end if;
  elsif tg_table_name = 'ideas' then
    if new.team_id is distinct from old.team_id
      and (
        exists (select 1 from amux.ideas where parent_idea_id = new.id)
        or exists (select 1 from amux.sessions where idea_id = new.id)
      ) then
      perform amux.reject_team_reassignment('ideas.team_id');
    end if;
  elsif tg_table_name = 'sessions' then
    if new.team_id is distinct from old.team_id
      and (
        exists (select 1 from amux.session_participants where session_id = new.id)
        or exists (select 1 from amux.messages where session_id = new.id)
      ) then
      perform amux.reject_team_reassignment('sessions.team_id');
    end if;
  else
    raise exception 'amux.enforce_parent_integrity is not defined for table %', tg_table_name;
  end if;

  return new;
end;
$function$;

-- No CASCADE: if anything outside the table (a view, a foreign key) has come
-- to depend on it, fail here rather than silently drop that too. Its own
-- policies, triggers, indexes and constraints go with it.
drop table if exists amux.idea_external_refs;
