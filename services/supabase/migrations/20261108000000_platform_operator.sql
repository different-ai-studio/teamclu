-- Platform operators and the support-session ledger (#1841).
--
-- docs/plans/2026-11-08-platform-operator-support-access.md.
--
-- A platform operator is an identity with admin_type 4 in the deployment's
-- platform org — the partner's SYSTEM_ADMIN ("manages every org"), scoped to
-- the platform org so a stray 4 in some customer org grants nothing. The
-- platform org is a deployment setting, not DEFAULT_ORG_ID (which is being
-- retired):
--
--   insert into amux.deployment_settings (key, value)
--   values ('platform_org_id', '"<org uuid>"');
--
-- Unset → nobody is an operator.
--
-- amux.support_grants records every time an operator enters a customer org:
-- one row per minted auth session, so concurrent operators sharing the org's
-- support account (20261108010000) stay distinguishable and revocable one by
-- one. Only service_role touches it.

create or replace function amux.platform_org_id()
returns uuid
language sql
stable security definer
set search_path to 'amux'
as $function$
  select case when (value #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then (value #>> '{}')::uuid end
    from amux.deployment_settings
   where key = 'platform_org_id';
$function$;

comment on function amux.platform_org_id() is
  'The deployment''s platform org (deployment setting platform_org_id, a JSON string uuid); NULL when unset or malformed. Its admin_type 4 identities are platform operators.';

revoke all on function amux.platform_org_id() from public;
grant execute on function amux.platform_org_id() to service_role;

-- p_user_id is an auth user id. A phone identity's public.users.id can differ
-- from its auth id, so match either column.
create or replace function amux.is_platform_operator(p_user_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'amux', 'public'
as $function$
  select p_user_id is not null
     and amux.platform_org_id() is not null
     and exists (
           select 1
             from public.users u
            where (u.id = p_user_id or u.auth_user_id = p_user_id)
              and u.org_id = amux.platform_org_id()
              and u.admin_type = 4
              and u.deleted_at is null
         );
$function$;

comment on function amux.is_platform_operator(uuid) is
  'True when the auth user is an admin_type 4 identity of amux.platform_org_id(). service_role only: FC decides who is an operator; clients ask GET /v1/admin/whoami.';

revoke all on function amux.is_platform_operator(uuid) from public;
grant execute on function amux.is_platform_operator(uuid) to service_role;

create table if not exists amux.support_grants (
  id               uuid primary key default gen_random_uuid(),
  session_id       uuid not null unique,
  operator_user_id uuid not null,
  org_id           uuid not null,
  support_user_id  uuid not null,
  team_id          uuid,
  reason           text not null check (btrim(reason) <> ''),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  revoked_at       timestamptz,
  check (expires_at > created_at)
);

comment on table amux.support_grants is
  'One row per support session a platform operator opened in a customer org. session_id is the auth.sessions id (the JWT session_id claim); operator_user_id the operator''s auth id; support_user_id the org''s shared support account. service_role only.';

create index if not exists support_grants_org_idx on amux.support_grants (org_id, created_at desc);
create index if not exists support_grants_open_idx on amux.support_grants (expires_at) where revoked_at is null;

alter table amux.support_grants enable row level security;
revoke all on amux.support_grants from anon, authenticated;
grant select, insert, update on amux.support_grants to service_role;
