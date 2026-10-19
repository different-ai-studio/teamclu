-- Public identity is independent of the name and team-local slug. Existing
-- resource names, deployments, and current name-based public hosts stay intact.
create or replace function amux.generate_app_code()
returns text language plpgsql volatile
set search_path = pg_catalog
as $$
declare
  -- The last 15 hex digits of a v4 UUID are 60 cryptographically random bits,
  -- beyond its version/variant bits. Twelve Base32 digits preserve all 60.
  bits bigint := ('x' || right(replace(gen_random_uuid()::text, '-', ''), 15))::bit(60)::bigint;
  alphabet constant text := '0123456789abcdefghjkmnpqrstvwxyz';
  code text := '';
begin
  for i in 1..12 loop
    code := substr(alphabet, (bits & 31)::int + 1, 1) || code;
    bits := bits >> 5;
  end loop;
  return code;
end;
$$;

alter table amux.apps
  add column app_code text,
  add column uses_app_code_domain boolean not null default false,
  add column deploy_use_app_code_domain boolean;

-- Backfilled apps keep their current domains. Only apps created afterwards
-- use code domains by default; deploy opt-in activates existing apps on success.
alter table amux.apps alter column uses_app_code_domain set default true;
alter table amux.apps add constraint apps_app_code_key unique (app_code);

-- Retry collisions during backfill, just as the Cloud API does on creation.
do $$
declare app_id uuid;
begin
  for app_id in select id from amux.apps where app_code is null loop
    loop
      begin
        update amux.apps set app_code = amux.generate_app_code() where id = app_id;
        exit;
      exception when unique_violation then
        -- Generate another independent code.
      end;
    end loop;
  end loop;
end;
$$;

alter table amux.apps
  alter column app_code set default amux.generate_app_code(),
  alter column app_code set not null,
  add constraint apps_app_code_format check (app_code ~ '^[0-9a-hjkmnp-tv-z]{12}$');

create or replace function amux.keep_app_code_immutable()
returns trigger language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.app_code is distinct from old.app_code then
    raise exception 'app_code is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger apps_app_code_immutable
before update of app_code on amux.apps
for each row execute function amux.keep_app_code_immutable();

comment on column amux.apps.app_code is
  'Permanent, globally unique 12-character random public identifier. Default domain: a-<app_code>.<APPS_PUBLIC_DOMAIN>. Not an access credential.';
