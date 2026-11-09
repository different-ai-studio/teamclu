-- An ended or expired support grant stops working at once, not when its access
-- token runs out (#1842).
--
-- docs/plans/2026-11-08-platform-operator-support-access.md.
--
-- Ending a grant deletes its auth session and refresh tokens, but the access
-- token already handed out is a signed JWT that PostgREST accepts until it
-- expires — up to an hour of reads through RLS after the operator left. Every
-- RLS helper and most RPCs resolve the caller from auth.uid() on their own,
-- so there is no single policy helper to put the check in. PostgREST's
-- pre-request hook runs before every request instead, and this function
-- refuses a support account's request whose JWT session has no live grant.
--
-- For every other caller it costs one unique-index probe on
-- amux.support_identities. It never fails open on malformed claims for a
-- support account, and never fails closed for anyone else.
--
-- The hook is registered as an in-database PostgREST setting on the
-- authenticator role. A deployment whose migration role may not alter that
-- role, or that already runs a different pre-request function, keeps its
-- configuration; the migration says so in a notice, and FC's own check
-- (services/fc/src/lib/platform-operators.ts) still covers every Cloud API
-- request there.

create or replace function amux.check_support_request()
returns void
language plpgsql
stable security definer
set search_path to 'amux'
as $function$
declare
  v_claims  jsonb;
  v_sub     text;
  v_session text;
begin
  begin
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  exception when others then
    return;  -- unparsable claims: PostgREST would not have let this through anyway
  end;
  v_sub := v_claims ->> 'sub';
  if v_sub is null or v_sub !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return;
  end if;
  if not exists (select 1 from amux.support_identities si where si.user_id = v_sub::uuid) then
    return;
  end if;

  v_session := v_claims ->> 'session_id';
  if v_session is null or not exists (
       select 1 from amux.support_grants g
        where g.support_user_id = v_sub::uuid
          and g.session_id::text = v_session
          and g.revoked_at is null
          and g.expires_at > now()
     ) then
    raise exception 'support session ended'
      using errcode = '42501',
            hint = 'The support grant behind this session was ended or expired.';
  end if;
end;
$function$;

comment on function amux.check_support_request() is
  'PostgREST pre-request hook: refuses a support account whose JWT session_id has no live support grant. A no-op for every other caller.';

revoke all on function amux.check_support_request() from public;
grant execute on function amux.check_support_request() to anon, authenticated, service_role;

-- support_grant_active (20261108010000) is the same rule as a boolean; keep the
-- two in step by having it ask the hook.
create or replace function amux.support_grant_active()
returns boolean
language plpgsql
stable security definer
set search_path to 'amux'
as $function$
begin
  perform amux.check_support_request();
  return true;
exception when insufficient_privilege then
  return false;
end;
$function$;

comment on function amux.support_grant_active() is
  'True for every caller except a support account whose JWT session_id has no live grant (amux.check_support_request as a boolean).';

do $do$
declare
  v_current text;
begin
  select split_part(cfg, '=', 2)
    into v_current
    from pg_db_role_setting s
    join pg_roles r on r.oid = s.setrole
   cross join lateral unnest(s.setconfig) cfg
   where r.rolname = 'authenticator'
     and s.setdatabase = 0
     and cfg like 'pgrst.db_pre_request=%';

  if v_current is not null and v_current <> 'amux.check_support_request' then
    raise notice 'authenticator already runs pre-request %; amux.check_support_request not registered', v_current;
    return;
  end if;

  begin
    execute 'alter role authenticator set pgrst.db_pre_request to ''amux.check_support_request''';
    notify pgrst, 'reload config';
  exception when others then
    raise notice 'could not register amux.check_support_request as the PostgREST pre-request hook (%); FC still checks support sessions', sqlerrm;
  end;
end;
$do$;
