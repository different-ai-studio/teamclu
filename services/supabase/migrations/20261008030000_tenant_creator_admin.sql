-- A new tenant's creator is its super admin (admin_type 3).
--
-- docs/plans/2026-10-08-staff-only-identity-model.md (T3).
--
-- amux.ensure_personal_org is where an account with no public.users row gets an
-- org of its own — reached from bootstrap_login_team on first login and from
-- create_team. It wrote `(id, org_id, mobile)` and nothing else, so creators
-- landed at the column default 1: a membership card as far as saas-mono (and
-- TeamClu's staff-only rule) can tell. Now the row it INSERTs is:
--   * admin_type 3 — partner deployments let only service_role UPDATE the
--     column, so it has to be right at INSERT;
--   * auth_user_id = id — the partner gateway resolves identities by it;
--   * mobile from a `<phone>@teamclu.mobile` account (phone sign-ups no longer
--     get a row at login, T4), so the identity is found by phone next time;
--   * linked in public.email_users_links for an email account, so identities
--     minted later by invites resolve back to it.
--
-- The team name is the org name (p_name). Clients now require it; an older
-- client that sends none still gets the derived name, as before.
--
-- Body otherwise carried forward from 20260916000000_bootstrap_team_name.sql.

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

  insert into public.orgs (name) values (v_name) returning id into v_org;
  begin
    insert into public.users (id, auth_user_id, org_id, mobile, admin_type)
    values (v_user, v_user, v_org, coalesce(v_mobile, ''), 3);
  exception when unique_violation then
    delete from public.orgs where id = v_org;
    select org_id into v_org from public.users where id = v_user limit 1;
    return v_org;
  end;

  if v_mobile is null and coalesce(v_email, '') <> ''
     and split_part(v_email, '@', 2) not in ('teamclu.email', 'teamclu.mobile') then
    insert into public.email_users_links (email, user_id, org_id)
    values (v_email, v_user, v_org)
    on conflict (user_id) do nothing;
  end if;

  return v_org;
end;
$function$;

comment on function amux.ensure_personal_org(text) is
  'The caller''s org; for an account with no public.users row, mints one named p_name (the team name; derived when absent) and an identity in it as its super admin (admin_type 3), carrying the phone of a <phone>@teamclu.mobile account and linking an email account in public.email_users_links.';
