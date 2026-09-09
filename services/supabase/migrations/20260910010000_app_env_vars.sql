-- Per-app environment variables, some of them secret.
--
-- Design: docs/specs/2026-09-10-app-control-panel-design.md §9
--
-- Distinct from amux.app_secrets, which holds credentials the PLATFORM mints
-- for an app (its storage token, its OAuth client secret) under fixed kinds.
-- These are the operator's own: arbitrary keys, chosen names, injected into the
-- deployed function's environment at finalize.
--
-- A row is either plain or secret, never both, and the check constraint is what
-- keeps that true. A plain value is stored readable on purpose — "not a secret"
-- is a choice the operator makes per key, and the whole distinction is only
-- meaningful if plain values can actually be read back and edited. Anything
-- that must not come back out is marked secret and lives in `ciphertext`, which
-- no endpoint returns.

create table if not exists amux.app_env_vars (
  app_id uuid not null references amux.apps(id) on delete cascade,
  key text not null,
  is_secret boolean not null default false,
  -- Exactly one of these is set; see the constraint below.
  value text,
  ciphertext text,
  updated_by_member_id uuid references amux.members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (app_id, key),
  -- POSIX-ish env name. Anything else either cannot be exported by a shell or
  -- cannot be read back by the runtime, and both fail silently at run time
  -- rather than loudly at save time.
  constraint app_env_vars_key_shape
    check (key ~ '^[A-Za-z_][A-Za-z0-9_]*$' and char_length(key) <= 128),
  constraint app_env_vars_one_kind_of_value
    check (
      (is_secret and ciphertext is not null and value is null)
      or (not is_secret and value is not null and ciphertext is null)
    ),
  constraint app_env_vars_value_size
    check (coalesce(char_length(value), 0) <= 8192)
);

create index if not exists app_env_vars_app_idx
  on amux.app_env_vars (app_id, key);

comment on table amux.app_env_vars is
  'Operator-defined environment for a deployed app, injected at finalizeDeploy. Applied BEFORE the platform''s own variables so a user key can never shadow DATABASE_URL or the storage token; the write path also refuses the reserved names outright.';

comment on column amux.app_env_vars.value is
  'Plaintext, and only for a non-secret row. Readable by design: "not a secret" is a per-key choice, and it only means anything if such a value can be read back and edited.';

comment on column amux.app_env_vars.ciphertext is
  'AES-256-GCM under APP_SECRETS_ENCRYPTION_KEY, same sealing as amux.app_secrets. No endpoint returns it — a secret is write-only once set, and replacing it means typing a new value. RLS is row-level, so a reader of this row can technically read the column; that is acceptable because the key lives only in FC''s environment and never in this database, which is the same bargain amux.app_secrets makes.';

-- ---------------------------------------------------------------------------
-- Two timestamps on amux.apps, so "your changes are not live yet" is a property
-- of the row rather than of one desktop's memory — exactly the reasoning behind
-- `deployed_auth_mode`.
--
-- A max(updated_at) subquery would avoid the columns but put a correlated
-- lookup on every app list; these two are written by the same code paths that
-- write the rows, and a delete bumps env_updated_at too.
--
-- Guarded with an existence check rather than `add column if not exists`: that
-- form checks ownership BEFORE it checks whether the column is there, so on a
-- deployment whose migrate role does not own amux.apps it fails with `must be
-- owner of table apps` even when there is nothing to do. CI runs as
-- supabase_admin and self-host as postgres, so the two disagree on ownership
-- and CI cannot see the failure.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'amux' and table_name = 'apps' and column_name = 'env_updated_at'
  ) then
    alter table amux.apps add column env_updated_at timestamptz;
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'amux' and table_name = 'apps' and column_name = 'env_deployed_at'
  ) then
    alter table amux.apps add column env_deployed_at timestamptz;
  end if;
end $$;

comment on column amux.apps.env_updated_at is
  'When this app''s env was last changed (including a delete). NULL means never.';

comment on column amux.apps.env_deployed_at is
  'When the running function last had this app''s env baked in. Compared against env_updated_at to tell the operator a redeploy is needed; NULL on an app whose env has never been deployed.';

-- ---------------------------------------------------------------------------
-- RLS. Reads are the `prompt` tier — the people who write the app's code and
-- therefore need to know what its environment contains — and RLS cannot express
-- a permission LEVEL, so the policy admits any grantee and the repository
-- narrows it to prompt/admin. Writes are creator-only here and go through the
-- service role for an `admin` grantee, exactly like app_member_access.
-- ---------------------------------------------------------------------------
alter table amux.app_env_vars enable row level security;

drop policy if exists app_env_vars_select on amux.app_env_vars;
create policy app_env_vars_select on amux.app_env_vars
for select to authenticated using (
  exists (
    select 1
      from amux.apps a
     where a.id = app_env_vars.app_id
       and a.created_by_actor_id = amux.current_actor_id_for_team(a.team_id)
  )
  or exists (
    select 1
      from amux.app_member_access ama
     where ama.app_id = app_env_vars.app_id
       and ama.member_id = amux.current_member_id()
  )
);

drop policy if exists app_env_vars_manage on amux.app_env_vars;
create policy app_env_vars_manage on amux.app_env_vars
for all to authenticated using (
  exists (
    select 1
      from amux.apps a
     where a.id = app_env_vars.app_id
       and a.created_by_actor_id = amux.current_actor_id_for_team(a.team_id)
  )
) with check (
  exists (
    select 1
      from amux.apps a
     where a.id = app_env_vars.app_id
       and a.created_by_actor_id = amux.current_actor_id_for_team(a.team_id)
  )
);

grant select, insert, update, delete on amux.app_env_vars to authenticated;
grant all on amux.app_env_vars to service_role;

notify pgrst, 'reload schema';
