-- Old rows and old writers always retain legacy provider resource identities.
-- Only the upgraded Cloud API creation path explicitly selects app_code.
alter table amux.apps
  add column function_naming_mode text not null default 'legacy',
  add constraint apps_function_naming_mode_check
    check (function_naming_mode in ('legacy', 'app_code'));

create or replace function amux.keep_app_function_naming_mode_immutable()
returns trigger language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.function_naming_mode is distinct from old.function_naming_mode then
    raise exception 'function_naming_mode is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger apps_function_naming_mode_immutable
before update of function_naming_mode on amux.apps
for each row execute function amux.keep_app_function_naming_mode_immutable();

comment on column amux.apps.function_naming_mode is
  'Immutable internal provider naming mode. Existing apps and older writers use legacy; upgraded Cloud API creation explicitly selects app_code. Independent of public-domain choice.';
