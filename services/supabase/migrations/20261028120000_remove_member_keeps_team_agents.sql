-- Removing a member no longer hard-deletes their TEAM agents, and the FK-blocker
-- mapping now also catches RESTRICT violations.
--
-- 1. remove_team_actor deleted every agent the removed member owned, team agents
--    included. A team agent belongs to the team: it writes team-sync files, and
--    amuxc_file_versions.created_by / amuxc_files.updated_by reference its actor
--    ON DELETE RESTRICT. So removing any member whose team agent had ever synced
--    a file failed (belayo, 2026-10-28: one team agent with 28 file versions
--    blocked its owner's removal). Team agents are now handed to the caller --
--    an owner/admin of the team, guaranteed by the checks above -- and keep their
--    history. Personal agents are still deleted with their owner.
--
-- 2. The exception block caught only foreign_key_violation (23503). Since
--    PostgreSQL 18 a RESTRICT foreign key reports restrict_violation (23001), so
--    on belayo (PG 18) the agent_delete_blocked_by_* tokens never fired and the
--    raw constraint error reached the UI. CI runs PG 17, which still reports
--    23503, so 025_agent_delete_authz kept passing. Catch both.

create or replace function amux.remove_team_actor(p_actor_id uuid)
returns void
language plpgsql
security definer
set search_path to 'amux', 'public', 'auth'
as $$
declare
  v_team_id uuid;
  v_actor_type text;
  v_caller_actor uuid;
  v_owned_agent_id uuid;
  v_agent_visibility text;
  v_agent_owner_member_id uuid;
begin
  if auth.uid() is null then
    raise exception 'remove_team_actor requires authentication'
      using errcode = '42501';
  end if;

  select team_id, actor_type
    into v_team_id, v_actor_type
  from amux.actors
  where id = p_actor_id;

  if v_team_id is null then
    raise exception 'actor not found'
      using errcode = '23503';
  end if;

  v_caller_actor := amux.current_actor_id_for_team(v_team_id);

  if v_caller_actor is null then
    raise exception 'remove_team_actor requires team membership'
      using errcode = '42501';
  end if;

  if v_caller_actor = p_actor_id then
    raise exception 'cannot remove your own actor'
      using errcode = '42501';
  end if;

  if v_actor_type = 'agent' then
    select visibility, owner_member_id
      into v_agent_visibility, v_agent_owner_member_id
    from amux.agents
    where id = p_actor_id;

    if v_agent_visibility = 'personal' then
      if v_caller_actor is distinct from v_agent_owner_member_id then
        raise exception 'remove_team_actor requires agent owner for personal agents'
          using errcode = '42501';
      end if;
    elsif v_agent_visibility = 'team' then
      if amux.current_team_role(v_team_id) not in ('owner', 'admin') then
        raise exception 'remove_team_actor requires owner or admin for team agents'
          using errcode = '42501';
      end if;
    else
      if amux.current_team_role(v_team_id) not in ('owner', 'admin') then
        raise exception 'remove_team_actor requires owner or admin'
          using errcode = '42501';
      end if;
    end if;
  else
    if amux.current_team_role(v_team_id) not in ('owner', 'admin') then
      raise exception 'remove_team_actor requires owner or admin'
        using errcode = '42501';
    end if;
  end if;

  if v_actor_type = 'member' and exists (
    select 1 from amux.team_members
     where team_id = v_team_id and member_id = p_actor_id and role = 'owner'
  ) then
    if (select count(*) from amux.team_members
          where team_id = v_team_id and role = 'owner') <= 1 then
      raise exception 'cannot remove the last owner'
        using errcode = '23514';
    end if;
  end if;

  begin
    if v_actor_type = 'member' then
      -- Team agents outlive the member: hand them to the caller (an owner or
      -- admin of this team) so their file history stays intact.
      update amux.agents
         set owner_member_id = v_caller_actor
       where owner_member_id = p_actor_id
         and visibility = 'team';

      -- Personal agents go with their owner.
      for v_owned_agent_id in
        select id from amux.agents where owner_member_id = p_actor_id
      loop
        delete from amux.agent_member_access
         where agent_id = v_owned_agent_id or member_id = v_owned_agent_id;

        delete from amux.team_members
         where member_id = v_owned_agent_id;

        delete from amux.actors where id = v_owned_agent_id;
      end loop;
    end if;

    delete from amux.agent_member_access
     where agent_id = p_actor_id or member_id = p_actor_id;

    delete from amux.team_members where member_id = p_actor_id;

    if v_actor_type = 'member' then
      delete from amux.members where id = p_actor_id;
    else
      delete from amux.agents where id = p_actor_id;
    end if;

    delete from amux.actors where id = p_actor_id;
  exception
    -- RESTRICT foreign keys raise restrict_violation on PostgreSQL 18+,
    -- foreign_key_violation before that.
    when foreign_key_violation or restrict_violation then
      raise exception '%', case
        when sqlerrm ilike '%idea_activities%' then 'agent_delete_blocked_by_idea_activities'
        when sqlerrm ilike '%apps_created_by%' or sqlerrm ilike '%apps_%actor%' then 'agent_delete_blocked_by_apps'
        when sqlerrm ilike '%amuxc_file%' then 'agent_delete_blocked_by_files'
        else 'actor_delete_blocked_by_references'
      end
      using errcode = '23503';
  end;
end;
$$;
