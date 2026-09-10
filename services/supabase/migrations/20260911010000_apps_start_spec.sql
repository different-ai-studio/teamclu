-- amux.apps.runtime becomes build.kind; start_spec snapshots the last
-- successfully deployed start declaration.
alter table amux.apps
  drop constraint if exists apps_runtime_check;

alter table amux.apps
  add constraint apps_runtime_check
  check (runtime in ('node', 'python', 'go', 'php', 'java', 'container'));

alter table amux.apps
  add column if not exists start_spec jsonb;

comment on column amux.apps.runtime is
  'build.kind from teamclu.app.json at last successful deploy (node|python|go|php|java|container)';

comment on column amux.apps.start_spec is
  'Snapshot of start{} from teamclu.app.json at last successful deploy; repo file remains source of truth';

notify pgrst, 'reload schema';
