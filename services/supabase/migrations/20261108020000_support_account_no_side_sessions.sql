-- A support account gets sessions only from amux.start_support_session (#1842).
--
-- switch_active_team and mint_identity_session mint a session for one of the
-- caller's own identities. Called from a support session, that identity is the
-- support account itself, and the new session would have no support_grants
-- row and no not_after: it would outlive the grant's expiry, and ending the
-- grant would not revoke it. Both now refuse a support account (42501).
--
-- The guard sits here rather than in auth._mint_session, which every mint goes
-- through: that function is owned by supabase_auth_admin on deployed
-- databases while migrations run as postgres, and CREATE OR REPLACE by a
-- non-owner fails ("must be owner of function") and blocks every later
-- migration (see migrations/README.md). claim_team_invite never mints for the
-- caller's own account, so it needs no guard.
--
-- Bodies restated from 20261008000000_staff_only_team_identities.sql and
-- 20261008040000_identity_selection.sql; only the support-account check is new.
-- Clients in a support session enter teams without activating them (the
-- support JWT already carries the org).

create or replace function amux.is_support_account(p_user_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'amux'
as $function$
  select exists (select 1 from amux.support_identities si where si.user_id = p_user_id);
$function$;

revoke all on function amux.is_support_account(uuid) from public;
grant execute on function amux.is_support_account(uuid) to authenticated, service_role;

create or replace function amux.switch_active_team(p_team_id uuid)
returns table(actor_id uuid, team_id uuid, refresh_token text)
language plpgsql security definer
set search_path to 'amux', 'public', 'auth', 'app'
as $function$
declare
  v_caller_id uuid := auth.uid();
  v_staff_only boolean := amux.staff_only();
  v_actor uuid;
  v_member_user_id uuid;
  v_rt text;
begin
  if v_caller_id is null then
    raise exception 'switch requires authentication' using errcode = '42501';
  end if;

  select a.id, a.user_id into v_actor, v_member_user_id
    from amux.actors a
   where a.team_id = p_team_id
     and a.user_id in (select p.id from amux.person_identities(v_caller_id) as p(id))
     -- Staff-only: never mint a session for a membership card, the caller's
     -- own included.
     and (not v_staff_only or amux.is_teamclu_identity(a.user_id))
   order by case when a.user_id = v_caller_id then 0 else 1 end, a.created_at asc
   limit 1;
  if v_actor is null then
    raise exception 'not a member of this team' using errcode = '42501';
  end if;

  if not exists (select 1 from auth.users where id = v_member_user_id) then
    raise exception 'linked team identity not found' using errcode = '42501';
  end if;

  if amux.is_support_account(v_member_user_id) then
    raise exception 'a support account''s sessions come only from a support grant' using errcode = '42501';
  end if;

  v_rt := auth._mint_session(v_member_user_id);
  update amux.actors set last_active_at = now(), updated_at = now() where id = v_actor;
  return query select v_actor, p_team_id, v_rt;
end;
$function$;

create or replace function amux.mint_identity_session(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $function$
begin
  if auth.uid() is null then
    raise exception 'identity switch requires authentication' using errcode = '42501';
  end if;
  if not exists (select 1 from amux.list_my_identities() i where i.user_id = p_user_id) then
    raise exception 'not one of your identities' using errcode = '42501';
  end if;
  if amux.is_support_account(p_user_id) then
    raise exception 'a support account''s sessions come only from a support grant' using errcode = '42501';
  end if;
  return auth._mint_session(p_user_id);
end;
$function$;
