-- Owner/admin can set another member's role to admin or member.
-- Cannot change own role, cannot change an owner, cannot mint a new owner.

create or replace function amux.set_team_member_role(p_actor_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path to 'amux', 'public', 'auth'
as $$
declare
  v_team_id uuid;
  v_actor_type text;
  v_caller_actor uuid;
  v_current_role text;
  v_new_role text;
begin
  -- The global actor-id helper was dropped in 20260804020000. Match
  -- remove_team_actor: auth.uid() for "is there a caller", then the
  -- per-team helper for self.
  if auth.uid() is null then
    raise exception 'set_team_member_role requires authentication'
      using errcode = '42501';
  end if;

  v_new_role := lower(btrim(coalesce(p_role, '')));
  if v_new_role not in ('admin', 'member') then
    raise exception 'role must be admin or member'
      using errcode = '23514';
  end if;

  select team_id, actor_type
    into v_team_id, v_actor_type
  from amux.actors
  where id = p_actor_id;

  if v_team_id is null then
    raise exception 'actor not found'
      using errcode = '23503';
  end if;

  if v_actor_type is distinct from 'member' then
    raise exception 'target must be a member'
      using errcode = '23514';
  end if;

  v_caller_actor := amux.current_actor_id_for_team(v_team_id);

  if v_caller_actor is null then
    raise exception 'set_team_member_role requires team membership'
      using errcode = '42501';
  end if;

  if v_caller_actor = p_actor_id then
    raise exception 'cannot change your own role'
      using errcode = '42501';
  end if;

  if amux.current_team_role(v_team_id) not in ('owner', 'admin') then
    raise exception 'set_team_member_role requires owner or admin'
      using errcode = '42501';
  end if;

  select role into v_current_role
  from amux.team_members
  where team_id = v_team_id and member_id = p_actor_id;

  if v_current_role is null then
    raise exception 'actor not found'
      using errcode = '23503';
  end if;

  if v_current_role = 'owner' then
    raise exception 'cannot change the owner role'
      using errcode = '42501';
  end if;

  if v_current_role = v_new_role then
    return;
  end if;

  update amux.team_members
     set role = v_new_role
   where team_id = v_team_id and member_id = p_actor_id;
end;
$$;

comment on function amux.set_team_member_role(uuid, text) is
  'Owner/admin: set another member role to admin or member. Cannot change self or owner.';

revoke all on function amux.set_team_member_role(uuid, text) from public;
grant execute on function amux.set_team_member_role(uuid, text) to authenticated;
grant execute on function amux.set_team_member_role(uuid, text) to service_role;
