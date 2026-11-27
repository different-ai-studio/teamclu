-- The 代开发 app's own corpid for a company.
--
-- A company's sign-in binding (sso_org_bindings.tenant_id) can hold the
-- plaintext corpid (`ww…`) while TeamClu's 代开发 app receives the encrypted
-- open corpid (`wp…`) for the same company. Matching the two by equality
-- dropped every 代开发 authorization. sso_directory_apps stays keyed by the
-- binding's tenant_id (identities use it); auth_corp_id is the id WeCom gives
-- the 代开发 app, used for its API calls and to find the row from its
-- callbacks. Null means the same as tenant_id.

alter table amux.sso_directory_apps
  add column if not exists auth_corp_id text;

comment on column amux.sso_directory_apps.auth_corp_id is
  'The corpid WeCom gives the 代开发 app for this company (often the encrypted open corpid); null = tenant_id.';

create unique index if not exists sso_directory_apps_auth_corp_id_key
  on amux.sso_directory_apps (provider, auth_corp_id)
  where auth_corp_id is not null;
