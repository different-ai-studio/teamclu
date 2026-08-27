-- amux.apps extensions for self-serve Gitea + auth_mode
--
-- Phase 1 of Apps self-serve (Gitea + Node FC). See
-- docs/specs/2026-08-27-apps-self-serve-gitea-fc-design.md.
--
--   git_commit_sha    — HEAD SHA of the app's Gitea repo at last successful
--                        deploy; lets the UI show what is actually live.
--   runtime           — 'node' (FC-managed Node runtime) | 'container'
--                        (bring-your-own image). Drives which deploy path
--                        startDeploy/finalizeDeploy take.
--   auth_mode         — 'none' | 'platform' (TeamClu SSO) | 'third' (the
--                        app's own OAuth client, oauth_client_id below).
--   oauth_client_id   — public client id when auth_mode = 'third'. Never a
--                        secret; the matching secret lives in app_secrets.
--   oauth_app_id      — internal linkage to the platform OAuth app row when
--                        auth_mode = 'platform'. Never exposed to clients.
--   deploy_token      — short-lived bearer the daemon presents when pushing a
--                        build; internal only, never exposed to clients.
--   deploy_started_at — when the current deploy attempt began; lets stuck
--                        `awaiting_build`/`deploying` rows be told apart from
--                        one that just started.
alter table amux.apps
  add column if not exists git_commit_sha text,
  add column if not exists runtime text not null default 'node',
  add column if not exists auth_mode text not null default 'none',
  add column if not exists oauth_client_id text,
  add column if not exists oauth_app_id uuid,
  add column if not exists deploy_token text,
  add column if not exists deploy_started_at timestamptz;

alter table amux.apps
  drop constraint if exists apps_runtime_check;
alter table amux.apps
  add constraint apps_runtime_check check (runtime in ('node', 'container'));

alter table amux.apps
  drop constraint if exists apps_auth_mode_check;
alter table amux.apps
  add constraint apps_auth_mode_check check (auth_mode in ('none', 'platform', 'third'));

-- Per-app encrypted secrets (OAuth client secret, deploy signing key, etc).
-- One row per (app, kind) — e.g. kind='oauth_client_secret'. Ciphertext only;
-- FC never stores plaintext here.
create table if not exists amux.app_secrets (
  app_id uuid not null references amux.apps(id) on delete cascade,
  kind text not null,
  ciphertext text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (app_id, kind)
);

-- RLS: service_role only for secrets (FC uses service role / pg path).
alter table amux.app_secrets enable row level security;
-- no authenticated policies — clients never read this table

grant all on amux.app_secrets to service_role;
