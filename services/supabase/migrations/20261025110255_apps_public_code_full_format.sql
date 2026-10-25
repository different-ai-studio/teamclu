-- Release batch B: deploy raw/full-code-compatible readers before this migration.
-- One statement keeps the locks, validation, DDL and backfill atomic both when
-- run directly and inside the migration runner's surrounding transaction.
do $migration$
begin
  -- Freeze new deployments and lifecycle claims before checking for active work.
  -- Keep the apps-first order used by begin_app_lifecycle. Do not reclaim tokens:
  -- even expired/orphaned tokens must be resolved by the normal lifecycle first.
  lock table amux.apps, amux.app_lifecycle_operations in access exclusive mode;

  if exists (
    select 1 from amux.apps
    where deploy_token is not null
      or fc_status in ('awaiting_build', 'building', 'deploying', 'uninstalling')
  ) or exists (
    select 1 from amux.app_lifecycle_operations
    where in_flight or status in ('pending', 'running')
  ) then
    raise exception 'app code migration requires idle lifecycle' using errcode = '55000';
  end if;

  if exists (
    select 1 from amux.apps
    where app_code is null or app_code !~ '^(a-)?[0-9a-hjkmnp-tv-z]{12}$'
  ) then
    raise exception 'app code migration invalid format' using errcode = '23514';
  end if;

  if exists (
    select 1 from amux.apps
    group by case when app_code ~ '^[0-9a-hjkmnp-tv-z]{12}$' then 'a-' || app_code else app_code end
    having count(*) > 1
  ) then
    raise exception 'app code migration normalized collision' using errcode = '23505';
  end if;

  -- Retain apps_app_code_key throughout. Only the code immutability trigger is
  -- suspended; other guards and all UUID references remain in force.
  alter table amux.apps drop constraint apps_app_code_format;
  alter table amux.apps disable trigger apps_app_code_immutable;
  update amux.apps set app_code = 'a-' || app_code
    where app_code ~ '^[0-9a-hjkmnp-tv-z]{12}$';

  create or replace function amux.generate_app_code()
  returns text language plpgsql volatile
  set search_path = pg_catalog
  as $$
  declare
    -- All 60 tail bits are outside the UUID version and variant fields.
    bits bigint := ('x' || right(replace(gen_random_uuid()::text, '-', ''), 15))::bit(60)::bigint;
    alphabet constant text := '0123456789abcdefghjkmnpqrstvwxyz';
    code text := '';
  begin
    for i in 1..12 loop
      code := substr(alphabet, (bits & 31)::int + 1, 1) || code;
      bits := bits >> 5;
    end loop;
    return 'a-' || code;
  end;
  $$;

  alter table amux.apps add constraint apps_app_code_format
    check (app_code ~ '^a-[0-9a-hjkmnp-tv-z]{12}$');
  alter table amux.apps enable trigger apps_app_code_immutable;

  if exists (select 1 from amux.apps where app_code is null or app_code !~ '^a-[0-9a-hjkmnp-tv-z]{12}$') then
    raise exception 'app code migration invalid final format' using errcode = '23514';
  end if;

  comment on column amux.apps.app_code is
    'Permanent, globally unique 14-character public identifier: a- plus 12 random Base32 characters (60 bits). Default domain: <app_code>.<APPS_PUBLIC_DOMAIN>. Not an access credential.';
end;
$migration$;
