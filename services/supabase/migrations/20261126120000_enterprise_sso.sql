-- Enterprise IM sign-in (WeCom first; DingTalk and Feishu later).
--
-- docs/specs/2026-11-26-enterprise-im-sso.md.
--
-- An org admin binds their company's WeCom corp to the org by installing
-- TeamClu's third-party WeCom app. Installing is something only a WeCom admin
-- can do, which is what makes the binding trustworthy: a regular employee
-- cannot claim a company for an org of their choosing. After that, anyone in the
-- corp who scans the WeCom QR code signs in to that org as a member identity
-- (admin_type 2), created on first scan.
--
-- Everything here is service_role only. FC runs the provider protocol (the
-- suite_ticket push, the QR login exchange, the install callback) and calls
-- these with the service-role key; no client reaches the tables or functions.
--
-- Tables:
--   sso_suite_tickets  the latest suite_ticket WeCom pushed (every 10 min);
--                      FC needs it to get a suite_access_token. Kept in the
--                      database because any FC replica may receive the push.
--   sso_org_bindings   company (provider, tenant_id = corpid) → org. One org
--                      per company.
--   sso_identities     (provider, tenant_id, subject = open_userid, org) → the
--                      auth account that person signs in as in that org.
--   sso_flows          short-lived login / install state between the browser
--                      redirect and the client's code exchange.
--
-- RPCs:
--   ensure_sso_identity  the person's identity in the bound org, minted on
--                        first sign-in. INSERT-only on public.users, as with
--                        every other identity path (the partner's
--                        prevent_admin_type_change trigger guards UPDATE).
--   sso_mint_session     a refresh token for that identity (auth._mint_session),
--                        refusing support accounts like mint_identity_session.

create table if not exists amux.sso_suite_tickets (
  provider   text not null,
  suite_id   text not null,
  ticket     text not null,
  updated_at timestamptz not null default now(),
  primary key (provider, suite_id)
);

comment on table amux.sso_suite_tickets is
  'Latest provider-pushed suite ticket (WeCom suite_ticket) per third-party app. service_role only.';

create table if not exists amux.sso_org_bindings (
  provider       text not null check (provider in ('wecom', 'dingtalk', 'feishu')),
  tenant_id      text not null,
  org_id         uuid not null references public.orgs (id) on delete cascade,
  tenant_name    text,
  -- WeCom permanent_code from the install. Needed for corp-scoped APIs
  -- (get_corp_token); kept server-side only.
  permanent_code text,
  bound_by       uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (provider, tenant_id)
);

create index if not exists idx_sso_org_bindings_org on amux.sso_org_bindings (org_id);

comment on table amux.sso_org_bindings is
  'Which org a company (WeCom corpid, ...) signs in to. Written only by the provider install callback. service_role only.';

create table if not exists amux.sso_identities (
  provider      text not null,
  tenant_id     text not null,
  subject       text not null,
  org_id        uuid not null references public.orgs (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz,
  primary key (provider, tenant_id, subject, org_id)
);

create index if not exists idx_sso_identities_user on amux.sso_identities (user_id);

comment on table amux.sso_identities is
  'The TeamClu identity a provider user (WeCom open_userid within a corp) signs in as, per org. service_role only.';

create table if not exists amux.sso_flows (
  state              text primary key,
  provider           text not null,
  kind               text not null check (kind in ('login', 'install')),
  -- login: the client's loopback / custom-scheme redirect and PKCE challenge.
  redirect           text,
  code_challenge     text,
  -- install: the org being bound and the admin who started it.
  org_id             uuid references public.orgs (id) on delete cascade,
  requested_by       uuid references auth.users (id) on delete cascade,
  -- login, after the provider callback: who signed in, and the hash of the
  -- one-time code handed to the client.
  user_id            uuid references auth.users (id) on delete cascade,
  exchange_code_hash text unique,
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null,
  consumed_at        timestamptz
);

create index if not exists idx_sso_flows_expires on amux.sso_flows (expires_at);

comment on table amux.sso_flows is
  'Short-lived SSO login / install state (minutes). Rows past expires_at are dead and swept by FC. service_role only.';

alter table amux.sso_suite_tickets enable row level security;
alter table amux.sso_org_bindings  enable row level security;
alter table amux.sso_identities    enable row level security;
alter table amux.sso_flows         enable row level security;

revoke all on amux.sso_suite_tickets, amux.sso_org_bindings, amux.sso_identities, amux.sso_flows
  from anon, authenticated;
grant select, insert, update, delete
  on amux.sso_suite_tickets, amux.sso_org_bindings, amux.sso_identities, amux.sso_flows
  to service_role;

-- The person's identity in the org their company is bound to, minted at
-- admin_type 2 on first sign-in. Raises P0002 when the company is not bound.
create or replace function amux.ensure_sso_identity(
  p_provider  text,
  p_tenant_id text,
  p_subject   text,
  p_nickname  text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $function$
declare
  v_org  uuid;
  v_id   uuid;
  v_name text;
begin
  if coalesce(btrim(p_provider), '') = '' or coalesce(btrim(p_tenant_id), '') = ''
     or coalesce(btrim(p_subject), '') = '' then
    raise exception 'provider, tenant and subject are required' using errcode = '22023';
  end if;

  select b.org_id into v_org
    from amux.sso_org_bindings b
   where b.provider = p_provider and b.tenant_id = p_tenant_id;
  if v_org is null then
    raise exception 'this company is not connected to any TeamClu organization'
      using errcode = 'P0002';
  end if;

  -- Serialise first sign-ins of one person: two concurrent scans must not mint
  -- two identities.
  perform pg_advisory_xact_lock(hashtextextended(
    'sso:' || p_provider || ':' || p_tenant_id || ':' || p_subject || ':' || v_org::text, 0));

  select i.user_id into v_id
    from amux.sso_identities i
    join public.users u on u.id = i.user_id and u.org_id = v_org and u.deleted_at is null
   where i.provider = p_provider and i.tenant_id = p_tenant_id
     and i.subject = p_subject and i.org_id = v_org;
  if v_id is not null then
    update amux.sso_identities set last_login_at = now()
     where provider = p_provider and tenant_id = p_tenant_id
       and subject = p_subject and org_id = v_org;
    return v_id;
  end if;

  -- A link whose identity row was deleted: drop it and mint afresh.
  delete from amux.sso_identities
   where provider = p_provider and tenant_id = p_tenant_id
     and subject = p_subject and org_id = v_org;

  -- WeCom does not tell a third-party app the person's name. Without one,
  -- resolve_caller_display_name would fall through to the email's local part —
  -- the account uuid — so name them after the provider until they rename.
  v_name := coalesce(nullif(btrim(p_nickname), ''),
    case p_provider when 'wecom' then '企业微信用户' when 'dingtalk' then '钉钉用户'
                    when 'feishu' then '飞书用户' else 'SSO' end
    || ' ' || left(md5(p_subject), 4));

  v_id := gen_random_uuid();
  insert into auth.users (id, email, email_confirmed_at, encrypted_password, confirmation_token, recovery_token,
    email_change_token_new, email_change, raw_app_meta_data, aud, role, created_at, updated_at, instance_id)
  values (v_id, v_id::text || '@teamclu.' || p_provider,
    now(), '', '', '', '', '', jsonb_build_object('org_id', v_org, 'sso_provider', p_provider),
    'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000');
  insert into public.users (id, auth_user_id, org_id, mobile, admin_type, nickname, email)
  values (v_id, v_id, v_org, '', 2, v_name, '');
  insert into amux.sso_identities (provider, tenant_id, subject, org_id, user_id, last_login_at)
  values (p_provider, p_tenant_id, p_subject, v_org, v_id, now());

  return v_id;
end;
$function$;

comment on function amux.ensure_sso_identity(text, text, text, text) is
  'The identity a provider user signs in as in the org their company is bound to (amux.sso_org_bindings), minted at admin_type 2 with a <id>@teamclu.<provider> auth account on first sign-in. P0002 when the company is not bound. service_role only.';

revoke all on function amux.ensure_sso_identity(text, text, text, text) from public;
grant execute on function amux.ensure_sso_identity(text, text, text, text) to service_role;

-- A refresh token for an SSO identity. Only for accounts that ensure_sso_identity
-- linked, so the service-role caller cannot use it to mint arbitrary sessions.
create or replace function amux.sso_mint_session(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $function$
begin
  if not exists (select 1 from amux.sso_identities i where i.user_id = p_user_id) then
    raise exception 'not an SSO identity' using errcode = '42501';
  end if;
  if amux.is_support_account(p_user_id) then
    raise exception 'a support account''s sessions come only from a support grant' using errcode = '42501';
  end if;
  return auth._mint_session(p_user_id);
end;
$function$;

comment on function amux.sso_mint_session(uuid) is
  'A refresh token (auth._mint_session) for an identity linked in amux.sso_identities. service_role only.';

revoke all on function amux.sso_mint_session(uuid) from public;
grant execute on function amux.sso_mint_session(uuid) to service_role;
