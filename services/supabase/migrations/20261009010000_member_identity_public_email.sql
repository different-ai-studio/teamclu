-- A member identity's public.users row carries the person's email.
--
-- The two functions that mint member identities — amux.ensure_member_identity
-- (joining a team by invite) and amux.ensure_personal_org (a tenant's creator)
-- — inserted public.users without email, so it stayed at the column default
-- ''. saas-mono lists staff from public.users and showed them with no email.
--
-- Now an email user's new row carries the email they sign in with — the one
-- public.email_users_links already records for them, not the synthetic
-- `<id>@teamclu.email` login of an invite-minted identity. Phone users keep a
-- blank email: their identity is `mobile`, and `<phone>@teamclu.mobile` is not
-- an address.
--
-- Not changed: rows that already exist, including a partner employee record
-- ensure_member_identity reuses. Backfilling is a manual step —
-- services/supabase/manual/member_identity_public_email_{precheck,backfill}.sql.
-- Agent accounts are 20261009000000_agent_account_public_email.sql.
--
-- Bodies otherwise carried forward verbatim from
-- 20261008020000_member_invite_new_identity.sql (ensure_member_identity) and
-- 20261008030000_tenant_creator_admin.sql (ensure_personal_org). Grants on
-- both are kept by CREATE OR REPLACE.

create or replace function amux.ensure_member_identity(p_caller uuid, p_org_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $function$
declare
  v_id           uuid;
  v_has_row      boolean;
  v_mobile       text;
  v_nickname     text;
  v_auth_email   text;
  v_person_email text;
begin
  -- Already staff there (a partner employee record, or an identity an earlier
  -- invite minted): join as that.
  select u.id into v_id
    from amux.person_identities(p_caller) as p(id)
    join public.users u on u.id = p.id
   where u.org_id = p_org_id and u.deleted_at is null and u.admin_type >= 2
     and exists (select 1 from auth.users au where au.id = u.id)
   order by (u.id = p_caller) desc, u.admin_type desc, u.created_at asc
   limit 1;
  if v_id is not null then
    return v_id;
  end if;

  select nullif(btrim(u.mobile), ''), u.nickname into v_mobile, v_nickname
    from public.users u where u.id = p_caller;
  v_has_row := found;
  select lower(btrim(au.email)) into v_auth_email from auth.users au where au.id = p_caller;
  -- A phone sign-up before it made a tenant: `<phone>@teamclu.mobile`, no row.
  if v_mobile is null and split_part(v_auth_email, '@', 2) = 'teamclu.mobile'
     and split_part(v_auth_email, '@', 1) ~ '^1[3-9][0-9]{9}$' then
    v_mobile := split_part(v_auth_email, '@', 1);
  end if;
  -- The email that names this person, for an email user.
  select l.email into v_person_email from public.email_users_links l where l.user_id = p_caller;
  if v_person_email is null and v_mobile is null and coalesce(v_auth_email, '') <> ''
     and split_part(v_auth_email, '@', 2) not in ('teamclu.email', 'teamclu.mobile') then
    v_person_email := v_auth_email;
  end if;

  if not v_has_row then
    -- First identity: the account they signed in with.
    v_id := p_caller;
    insert into public.users (id, auth_user_id, org_id, mobile, admin_type, email)
    values (v_id, v_id, p_org_id, coalesce(v_mobile, ''), 2, coalesce(v_person_email, ''));
  else
    v_id := gen_random_uuid();
    insert into auth.users (id, email, email_confirmed_at, encrypted_password, confirmation_token, recovery_token,
      email_change_token_new, email_change, raw_app_meta_data, aud, role, created_at, updated_at, instance_id)
    values (v_id,
      v_id::text || case when v_mobile is not null then '@teamclu.mobile' else '@teamclu.email' end,
      now(), '', '', '', '', '', jsonb_build_object('org_id', p_org_id),
      'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000');
    insert into public.users (id, auth_user_id, org_id, mobile, admin_type, nickname, email)
    values (v_id, v_id, p_org_id, coalesce(v_mobile, ''), 2, v_nickname, coalesce(v_person_email, ''));
  end if;

  if v_person_email is not null then
    -- Both ends: the caller's own identity (if it has a row) and the new one.
    insert into public.email_users_links (email, user_id, org_id)
    select v_person_email, u.id, u.org_id from public.users u where u.id = p_caller
    on conflict (user_id) do nothing;
    insert into public.email_users_links (email, user_id, org_id)
    values (v_person_email, v_id, p_org_id)
    on conflict (user_id) do nothing;
  end if;

  return v_id;
end;
$function$;

comment on function amux.ensure_member_identity(uuid, uuid) is
  'The caller''s identity in p_org_id, minted at admin_type 2 when they have none: reuses a live staff identity of theirs there, else turns a row-less account into the identity, else creates a new auth account (<id>@teamclu.mobile / <id>@teamclu.email) and row. Links email users'' identities in public.email_users_links and writes that email to the new row''s public.users.email (phone users: blank). INSERT-only.';

CREATE OR REPLACE FUNCTION amux.ensure_personal_org(p_name text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'amux', 'public', 'auth', 'extensions'
AS $function$
declare
  v_user  uuid := auth.uid();
  v_org   uuid;
  v_name  text;
  v_email text;
  v_mobile text;
  v_person_email text;
begin
  if v_user is null then
    raise exception 'ensure_personal_org requires an authenticated user' using errcode = '42501';
  end if;

  select org_id into v_org from public.users where id = v_user limit 1;
  if v_org is not null then
    return v_org;
  end if;

  v_name := coalesce(
    nullif(btrim(p_name), ''),
    nullif(btrim(amux.resolve_caller_display_name()), ''),
    'Personal'
  );

  select lower(btrim(au.email)) into v_email from auth.users au where au.id = v_user;
  if split_part(v_email, '@', 2) = 'teamclu.mobile'
     and split_part(v_email, '@', 1) ~ '^1[3-9][0-9]{9}$' then
    v_mobile := split_part(v_email, '@', 1);
  end if;

  -- The person's email for an email account; synthetic accounts and phone
  -- users leave public.users.email blank, as before.
  if v_mobile is null and coalesce(v_email, '') <> ''
     and split_part(v_email, '@', 2) not in ('teamclu.email', 'teamclu.mobile') then
    v_person_email := v_email;
  end if;

  insert into public.orgs (name) values (v_name) returning id into v_org;
  begin
    insert into public.users (id, auth_user_id, org_id, mobile, admin_type, email)
    values (v_user, v_user, v_org, coalesce(v_mobile, ''), 3, coalesce(v_person_email, ''));
  exception when unique_violation then
    delete from public.orgs where id = v_org;
    select org_id into v_org from public.users where id = v_user limit 1;
    return v_org;
  end;

  if v_person_email is not null then
    insert into public.email_users_links (email, user_id, org_id)
    values (v_person_email, v_user, v_org)
    on conflict (user_id) do nothing;
  end if;

  return v_org;
end;
$function$;

comment on function amux.ensure_personal_org(text) is
  'The caller''s org; for an account with no public.users row, mints one named p_name (the team name; derived when absent) and an identity in it as its super admin (admin_type 3), carrying the phone of a <phone>@teamclu.mobile account and linking an email account in public.email_users_links and writing its email to public.users.email.';
