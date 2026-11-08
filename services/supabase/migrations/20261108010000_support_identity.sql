-- The shared support account of each org, and support sessions (#1842).
--
-- docs/plans/2026-11-08-platform-operator-support-access.md.
--
-- TeamClu's RLS is actor-based (author_actor_id, session participants,
-- current_member_id, roles_users), so a platform operator "enters" an org by
-- acting as a real identity there rather than through an admin_type 4 bypass
-- in every policy. Each org gets ONE such identity, shared by all operators:
--
--   * auth.users  support-<org id>@teamclu.support, no password — nobody can
--     sign in to it; FC mints its sessions with service_role;
--   * public.users admin_type 2, nickname 'TeamClu 支持' (INSERT only, so the
--     partner trigger prevent_admin_type_change never fires);
--   * public.roles_users the org's system `owner` role;
--   * amux.support_identities marks it (public.users has no metadata column
--     here, and on partner deployments that column is theirs).
--
-- No mobile and no email_users_links row: amux.person_identities never
-- connects it to a person, so it shows up in nobody's identity picker and
-- mint_identity_session cannot reach it.
--
-- Operators are told apart by session, not account: amux.start_support_session
-- mints a fresh auth session per entry and records it in amux.support_grants
-- (20261108000000). Ending or expiring a grant deletes that one session.

create table if not exists amux.support_identities (
  org_id     uuid primary key,
  user_id    uuid not null unique,
  created_at timestamptz not null default now()
);

comment on table amux.support_identities is
  'The shared support account of each org (auth id = public.users id). Created by amux.ensure_support_identity. service_role only.';

alter table amux.support_identities enable row level security;
revoke all on amux.support_identities from anon, authenticated;
grant select on amux.support_identities to service_role;

create or replace function amux.ensure_support_identity(p_org_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $function$
declare
  v_id    uuid;
  v_email text;
  v_role  uuid;
begin
  if p_org_id is null or not exists (select 1 from public.orgs o where o.id = p_org_id) then
    raise exception 'org not found' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('amux.support_identity:' || p_org_id::text, 0));

  select si.user_id into v_id from amux.support_identities si where si.org_id = p_org_id;

  if v_id is null then
    v_id := gen_random_uuid();
    v_email := 'support-' || p_org_id::text || '@teamclu.support';
    insert into auth.users (id, email, email_confirmed_at, encrypted_password, confirmation_token, recovery_token,
      email_change_token_new, email_change, raw_app_meta_data, aud, role, created_at, updated_at, instance_id)
    values (v_id, v_email, now(), '', '', '', '', '',
      jsonb_build_object('org_id', p_org_id, 'teamclu_support', true),
      'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000');
    insert into public.users (id, auth_user_id, org_id, email, mobile, nickname, admin_type)
    values (v_id, v_id, p_org_id, v_email, '', 'TeamClu 支持', 2);
    insert into amux.support_identities (org_id, user_id) values (p_org_id, v_id);
  end if;

  -- Owner of the org, re-asserted on every call so a role taken away by hand
  -- comes back the next time an operator enters.
  perform amux.ensure_org_system_roles(p_org_id);
  select r.id into v_role from public.roles r where r.org_id = p_org_id and r.code = 'owner';
  if v_role is null then
    raise exception 'system role owner missing for org %', p_org_id;
  end if;
  update public.roles_users ru
     set status = 'active', expires_at = null
   where ru.user_id = v_id and ru.role_id = v_role and ru.store_id is null
     and (ru.status <> 'active' or ru.expires_at is not null);
  -- NOT EXISTS rather than ON CONFLICT: partner deployments key roles_users on
  -- (user_id, role_id, store_id) with a NULL store_id never conflicting.
  insert into public.roles_users (user_id, role_id, org_id, status)
  select v_id, v_role, p_org_id, 'active'
   where not exists (select 1 from public.roles_users ru
                      where ru.user_id = v_id and ru.role_id = v_role and ru.store_id is null);

  return v_id;
end;
$function$;

comment on function amux.ensure_support_identity(uuid) is
  'The org''s shared support account (amux.support_identities), created on first use: no-password auth account support-<org>@teamclu.support, public.users admin_type 2 ''TeamClu 支持'', org owner role (re-asserted on every call). INSERT-only on public.users. service_role only.';

revoke all on function amux.ensure_support_identity(uuid) from public;
grant execute on function amux.ensure_support_identity(uuid) to service_role;

create or replace function amux.ensure_support_actor(p_team_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $function$
declare
  v_org   uuid;
  v_user  uuid;
  v_actor uuid;
begin
  select t.oid into v_org from amux.teams t where t.id = p_team_id;
  if v_org is null then
    raise exception 'team not found' using errcode = 'P0002';
  end if;

  v_user := amux.ensure_support_identity(v_org);

  select a.id into v_actor
    from amux.actors a
   where a.team_id = p_team_id and a.user_id = v_user and a.actor_type = 'member'
   order by a.created_at
   limit 1;

  if v_actor is null then
    insert into amux.actors (team_id, actor_type, user_id, display_name, last_active_at)
    values (p_team_id, 'member', v_user, 'TeamClu 支持', now())
    returning id into v_actor;
  end if;

  insert into amux.members (id, status) values (v_actor, 'active')
  on conflict (id) do update set status = 'active';
  insert into amux.team_members (team_id, member_id, role)
  select p_team_id, v_actor, 'member'
   where not exists (select 1 from amux.team_members tm
                      where tm.team_id = p_team_id and tm.member_id = v_actor);

  return v_actor;
end;
$function$;

comment on function amux.ensure_support_actor(uuid) is
  'The support account''s member actor in a team (created, or reactivated, on demand). Its authority comes from the org owner role in roles_users, not team_members.role. service_role only.';

revoke all on function amux.ensure_support_actor(uuid) from public;
grant execute on function amux.ensure_support_actor(uuid) to service_role;

-- Revoke one support session: the auth session and its refresh tokens go, the
-- grant row stays as the record. Returns whether a live grant was ended.
create or replace function amux.revoke_support_grant(p_grant_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'amux', 'auth'
as $function$
declare
  v_session uuid;
begin
  update amux.support_grants g
     set revoked_at = now()
   where g.id = p_grant_id and g.revoked_at is null
  returning g.session_id into v_session;

  if v_session is null then
    return false;
  end if;

  update auth.refresh_tokens rt set revoked = true where rt.session_id = v_session;
  delete from auth.sessions s where s.id = v_session;
  return true;
end;
$function$;

revoke all on function amux.revoke_support_grant(uuid) from public;
grant execute on function amux.revoke_support_grant(uuid) to service_role;

-- Ends every grant past its expiry. Called on each start/end so expired
-- sessions are swept without a scheduler; GoTrue's sessions.not_after (set at
-- mint time where the column exists) already refuses their refresh.
create or replace function amux.expire_support_grants()
returns integer
language plpgsql
security definer
set search_path to 'amux', 'auth'
as $function$
declare
  v_grant uuid;
  v_n     integer := 0;
begin
  for v_grant in
    select g.id from amux.support_grants g
     where g.revoked_at is null and g.expires_at <= now()
  loop
    if amux.revoke_support_grant(v_grant) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$function$;

revoke all on function amux.expire_support_grants() from public;
grant execute on function amux.expire_support_grants() to service_role;

create or replace function amux.start_support_session(
  p_operator_user_id uuid,
  p_team_id          uuid,
  p_reason           text,
  p_ttl              interval default interval '4 hours'
)
returns table (
  grant_id        uuid,
  session_id      uuid,
  refresh_token   text,
  org_id          uuid,
  team_id         uuid,
  actor_id        uuid,
  support_user_id uuid,
  expires_at      timestamptz
)
language plpgsql
security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $function$
declare
  v_org     uuid;
  v_actor   uuid;
  v_user    uuid;
  v_session uuid := gen_random_uuid();
  v_rt      text := substring(encode(extensions.gen_random_bytes(6), 'hex'), 1, 12);
  v_expires timestamptz;
  v_grant   uuid;
begin
  if not amux.is_platform_operator(p_operator_user_id) then
    raise exception 'not a platform operator' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'reason is required' using errcode = '22023';
  end if;
  if p_ttl is null or p_ttl <= interval '0' or p_ttl > interval '24 hours' then
    raise exception 'ttl must be within 24 hours' using errcode = '22023';
  end if;

  select t.oid into v_org from amux.teams t where t.id = p_team_id;
  if v_org is null then
    raise exception 'team not found' using errcode = 'P0002';
  end if;
  if v_org = amux.platform_org_id() then
    raise exception 'the platform org is entered as yourself, not through support' using errcode = '22023';
  end if;

  perform amux.expire_support_grants();

  v_actor := amux.ensure_support_actor(p_team_id);
  select si.user_id into v_user from amux.support_identities si where si.org_id = v_org;
  v_expires := now() + p_ttl;

  -- auth._mint_session, inlined to know the session id.
  insert into auth.sessions (id, user_id, aal, created_at, updated_at)
  values (v_session, v_user, 'aal1', now(), now());
  if exists (select 1 from information_schema.columns
              where table_schema = 'auth' and table_name = 'sessions' and column_name = 'not_after') then
    execute 'update auth.sessions set not_after = $1 where id = $2' using v_expires, v_session;
  end if;
  insert into auth.refresh_tokens (token, user_id, session_id, revoked, instance_id, created_at, updated_at)
  values (v_rt, v_user::text, v_session, false, '00000000-0000-0000-0000-000000000000', now(), now());

  insert into amux.support_grants (session_id, operator_user_id, org_id, support_user_id, team_id, reason, expires_at)
  values (v_session, p_operator_user_id, v_org, v_user, p_team_id, btrim(p_reason), v_expires)
  returning id into v_grant;

  return query select v_grant, v_session, v_rt, v_org, p_team_id, v_actor, v_user, v_expires;
end;
$function$;

comment on function amux.start_support_session(uuid, uuid, text, interval) is
  'A platform operator enters a team of a customer org: ensures the org''s support account and its actor in the team, mints a fresh auth session for it (not_after = expiry where GoTrue has the column) and records the grant. 42501 not an operator, 22023 bad reason/ttl or the platform org itself, P0002 unknown team. service_role only.';

revoke all on function amux.start_support_session(uuid, uuid, text, interval) from public;
grant execute on function amux.start_support_session(uuid, uuid, text, interval) to service_role;

-- Ends the support session a caller is using. p_session_id comes from the
-- caller's verified JWT; p_user_id must be the support account it belongs to,
-- so nobody can end someone else's grant by guessing a session id.
create or replace function amux.end_support_session(p_user_id uuid, p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'amux'
as $function$
declare
  v_grant uuid;
begin
  perform amux.expire_support_grants();
  select g.id into v_grant
    from amux.support_grants g
   where g.session_id = p_session_id and g.support_user_id = p_user_id and g.revoked_at is null;
  if v_grant is null then
    return false;
  end if;
  return amux.revoke_support_grant(v_grant);
end;
$function$;

revoke all on function amux.end_support_session(uuid, uuid) from public;
grant execute on function amux.end_support_session(uuid, uuid) to service_role;

-- For RLS or guards that want to stop a support session the moment it is
-- revoked (its access token otherwise lives until it expires). Not wired into
-- any policy yet.
create or replace function amux.support_grant_active()
returns boolean
language sql
stable security definer
set search_path to 'amux'
as $function$
  select not exists (select 1 from amux.support_identities si where si.user_id = auth.uid())
      or exists (
           select 1 from amux.support_grants g
            where g.support_user_id = auth.uid()
              and g.session_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'session_id')
              and g.revoked_at is null
              and g.expires_at > now()
         );
$function$;

comment on function amux.support_grant_active() is
  'True for every caller except a support account whose JWT session_id has no live grant. Not yet used by any policy.';

revoke all on function amux.support_grant_active() from public;
grant execute on function amux.support_grant_active() to authenticated, service_role;

-- Who is behind a support session, for FC (whoami, the client banner).
create or replace function amux.support_session_info(p_user_id uuid, p_session_id uuid)
returns table (grant_id uuid, operator_user_id uuid, org_id uuid, team_id uuid, expires_at timestamptz)
language sql
stable security definer
set search_path to 'amux'
as $function$
  select g.id, g.operator_user_id, g.org_id, g.team_id, g.expires_at
    from amux.support_grants g
   where g.session_id = p_session_id
     and g.support_user_id = p_user_id
     and g.revoked_at is null
     and g.expires_at > now();
$function$;

revoke all on function amux.support_session_info(uuid, uuid) from public;
grant execute on function amux.support_session_info(uuid, uuid) to service_role;
