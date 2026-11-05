-- The last successful deployment's daemon build check. Null on older
-- deployments and after a successful finalize from a client without evidence.
alter table amux.apps
  add column if not exists artifact_verification jsonb,
  add column if not exists deploy_attempt_id uuid;
