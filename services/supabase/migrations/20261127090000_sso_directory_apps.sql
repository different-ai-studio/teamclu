-- Real member names for enterprise sign-in, through a WeCom 代开发 app.
--
-- docs/specs/2026-11-26-wecom-customized-app-names.md.
--
-- WeCom gives TeamClu's third-party app no member names, so SSO accounts start
-- as "企业微信用户 xxxx" (amux.ensure_sso_identity). A company that also
-- authorizes TeamClu's 代开发 (provider-developed self-built) app, and grants it
-- 「姓名」, lets FC read real names with user/get. FC then replaces the
-- placeholder — never a name the person chose.
--
-- Everything here is service_role only, like the rest of the sso_* surface.
--
--   sso_directory_apps        a company's 代开发 authorization: its secret
--                             (permanent_code) and whether names are readable.
--   sso_flows.kind            gains 'directory' for the authorization QR link.
--   sso_identities_needing_name  the identities of a company still on the
--                             placeholder name.
--   sso_apply_directory_name  replace the placeholder with the directory name.

alter table amux.sso_flows drop constraint if exists sso_flows_kind_check;
alter table amux.sso_flows
  add constraint sso_flows_kind_check check (kind in ('login', 'install', 'directory'));

create table if not exists amux.sso_directory_apps (
  provider        text not null,
  tenant_id       text not null,
  -- The 代开发 app's secret in that company (WeCom permanent_code); used as
  -- corpsecret for gettoken. Server-side only.
  permanent_code  text not null,
  -- Last result of agent/get_permissions: true once 「姓名」 is readable.
  names_granted   boolean not null default false,
  last_checked_at timestamptz,
  last_error      text,
  authorized_by   uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (provider, tenant_id),
  -- Only a company that signs in to an org can have a directory app; unbinding
  -- the company drops it.
  foreign key (provider, tenant_id)
    references amux.sso_org_bindings (provider, tenant_id) on delete cascade
);

comment on table amux.sso_directory_apps is
  'A company''s authorization of TeamClu''s WeCom 代开发 app, used to read member names. service_role only.';

alter table amux.sso_directory_apps enable row level security;
revoke all on amux.sso_directory_apps from anon, authenticated;
grant select, insert, update, delete on amux.sso_directory_apps to service_role;

-- The fallback name ensure_sso_identity gives an account. Kept in one place so
-- the two functions below agree on what "still a placeholder" means.
create or replace function amux.sso_is_placeholder_name(p_name text)
returns boolean
language sql
immutable
as $function$
  select coalesce(p_name ~ '^(企业微信用户|钉钉用户|飞书用户|SSO) [0-9a-f]{4}$', false);
$function$;

comment on function amux.sso_is_placeholder_name(text) is
  'True for the fallback nickname amux.ensure_sso_identity gives an SSO account.';

revoke all on function amux.sso_is_placeholder_name(text) from public;
grant execute on function amux.sso_is_placeholder_name(text) to service_role;

-- The identities of a company whose account still carries the placeholder
-- name, in its profile or in any team.
create or replace function amux.sso_identities_needing_name(p_provider text, p_tenant_id text)
returns table (subject text, user_id uuid)
language sql
stable
security definer
set search_path to 'amux', 'public'
as $function$
  select distinct i.subject, i.user_id
    from amux.sso_identities i
   where i.provider = p_provider
     and i.tenant_id = p_tenant_id
     and (
       exists (select 1 from public.users u
                where u.auth_user_id = i.user_id
                  and amux.sso_is_placeholder_name(u.nickname))
       or exists (select 1 from amux.actors a
                   where a.user_id = i.user_id
                     and a.actor_type = 'member'
                     and amux.sso_is_placeholder_name(a.display_name))
     );
$function$;

comment on function amux.sso_identities_needing_name(text, text) is
  'Identities of a company (provider, tenant_id) still on the SSO placeholder name. service_role only.';

revoke all on function amux.sso_identities_needing_name(text, text) from public;
grant execute on function amux.sso_identities_needing_name(text, text) to service_role;

-- Replace the placeholder name of an SSO account with its directory name, in
-- the profile and in every team. A name the person chose is left alone.
-- Returns whether anything changed.
create or replace function amux.sso_apply_directory_name(p_user_id uuid, p_name text)
returns boolean
language plpgsql
security definer
set search_path to 'amux', 'public'
as $function$
declare
  v_name    text := nullif(btrim(p_name), '');
  v_users   int;
  v_actors  int;
begin
  if v_name is null or char_length(v_name) > 64 then
    raise exception 'a name of 1 to 64 characters is required' using errcode = '22023';
  end if;
  if not exists (select 1 from amux.sso_identities i where i.user_id = p_user_id) then
    raise exception 'not an SSO identity' using errcode = '42501';
  end if;

  update public.users u
     set nickname = v_name
   where u.auth_user_id = p_user_id
     and amux.sso_is_placeholder_name(u.nickname);
  get diagnostics v_users = row_count;

  update amux.actors a
     set display_name = v_name,
         updated_at = now()
   where a.user_id = p_user_id
     and a.actor_type = 'member'
     and amux.sso_is_placeholder_name(a.display_name);
  get diagnostics v_actors = row_count;

  return v_users + v_actors > 0;
end;
$function$;

comment on function amux.sso_apply_directory_name(uuid, text) is
  'Replace an SSO account''s placeholder name (profile and team member actors) with its directory name; chosen names are kept. service_role only.';

revoke all on function amux.sso_apply_directory_name(uuid, text) from public;
grant execute on function amux.sso_apply_directory_name(uuid, text) to service_role;
