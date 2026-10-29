-- Self-service sign-up failed on belayo with
--   insert or update on table "audit_logs" violates foreign key constraint
--   "audit_logs_user_id_fkey"
-- See the comment at the org insert. Body otherwise identical to
-- 20261009010000_member_identity_public_email.sql.

CREATE OR REPLACE FUNCTION amux.ensure_personal_org(p_name text DEFAULT NULL::text)
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
  v_sub    text;
  v_claims text;
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

  -- public.orgs carries an audit trigger (log_audit_changes) that records
  -- auth.uid() in audit_logs.user_id, an FK to public.users. This caller has no
  -- public.users row until the insert below, so the trigger's FK check fails
  -- and sign-up dies with audit_logs_user_id_fkey. Blank the actor for just
  -- this statement (the trigger accepts NULL) and put it back straight after.
  v_sub    := current_setting('request.jwt.claim.sub', true);
  v_claims := current_setting('request.jwt.claims', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  insert into public.orgs (name) values (v_name) returning id into v_org;
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
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

grant execute on function amux.ensure_personal_org(text) to authenticated, service_role;
