-- App platform P3.3 — where an app's code lives leaves the app row.
--
-- docs/specs/2026-11-26-app-platform-p3-retire-legacy.md §2 (P3.3, the
-- original P1.5 of 2026-11-25-app-platform-p1-gitea-out.md).
--
--   amux.app_forge_repos     TeamClu's forge: the app's repo and how this
--                            deployment authenticates to it. Replaces
--                            apps.git_remote_url / git_auth_kind.
--   apps.deployed_revision   The source revision of the last finalized
--                            deploy, as the client named it (for a git app,
--                            its commit). Replaces apps.git_commit_sha; the
--                            platform does not know what a commit is.
--
-- Until P3.4 drops the old columns, FC writes both and the triggers below
-- project the old columns onto the new places, so an FC image from before
-- this step (which writes only the old columns) leaves them current too.
-- Backfilled here; idempotent.
--
-- Rollback: drop the triggers, the functions, the table and the column. The
-- old columns are untouched throughout.

-- ── 1. app_forge_repos (TeamClu) ───────────────────────────────────────────

create table if not exists amux.app_forge_repos (
  app_id      uuid primary key references amux.apps(id) on delete cascade,
  remote_url  text not null,
  -- 'gitea_deploy_key': a repo this deployment hosts; 'https_token': an
  -- imported http(s) repo with a stored token; null: imported, no credential.
  -- Older values ('pat') are carried as they are.
  auth_kind   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists app_forge_repos_auth_kind_idx on amux.app_forge_repos (auth_kind);

comment on table amux.app_forge_repos is
  'TeamClu''s forge record of where an app''s code lives. The app platform reads it only through its forge hooks.';

alter table amux.app_forge_repos enable row level security;
revoke all on amux.app_forge_repos from anon, authenticated;
grant all on amux.app_forge_repos to service_role;
grant select on amux.app_forge_repos to authenticated;

-- Whoever sees an app sees where its code lives, as with apps.git_remote_url.
-- Writes are the forge's, with the service role.
drop policy if exists app_forge_repos_select_if_visible on amux.app_forge_repos;
create policy app_forge_repos_select_if_visible on amux.app_forge_repos
  for select to authenticated
  using (app_id in (select app_id from amux.caller_apps()));

-- ── 2. apps.deployed_revision (platform) ───────────────────────────────────

alter table amux.apps add column if not exists deployed_revision text;

comment on column amux.apps.deployed_revision is
  'The source revision of the last finalized deploy, as the client named it. Opaque to the platform.';

-- ── 3. projection of the old columns (until P3.4) ──────────────────────────

create or replace function amux.trg_apps_forge_project()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if new.git_remote_url is null then
    delete from amux.app_forge_repos where app_id = new.id;
  else
    insert into amux.app_forge_repos (app_id, remote_url, auth_kind)
    values (new.id, new.git_remote_url, new.git_auth_kind)
    on conflict (app_id) do update
       set remote_url = excluded.remote_url,
           auth_kind = excluded.auth_kind,
           updated_at = now()
     where (amux.app_forge_repos.remote_url, amux.app_forge_repos.auth_kind)
           is distinct from (excluded.remote_url, excluded.auth_kind);
  end if;
  return null;
end;
$$;
revoke all on function amux.trg_apps_forge_project() from public, anon, authenticated;

drop trigger if exists apps_forge_project on amux.apps;
create trigger apps_forge_project
  after insert or update of git_remote_url, git_auth_kind on amux.apps
  for each row execute function amux.trg_apps_forge_project();

-- An explicit deployed_revision wins; otherwise it follows git_commit_sha.
create or replace function amux.trg_apps_deployed_revision()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  if tg_op = 'INSERT' then
    new.deployed_revision := coalesce(new.deployed_revision, new.git_commit_sha);
  elsif new.git_commit_sha is distinct from old.git_commit_sha
        and new.deployed_revision is not distinct from old.deployed_revision then
    new.deployed_revision := new.git_commit_sha;
  end if;
  return new;
end;
$$;
revoke all on function amux.trg_apps_deployed_revision() from public, anon, authenticated;

drop trigger if exists apps_deployed_revision on amux.apps;
create trigger apps_deployed_revision
  before insert or update of git_commit_sha on amux.apps
  for each row execute function amux.trg_apps_deployed_revision();

-- ── 4. backfill ────────────────────────────────────────────────────────────

insert into amux.app_forge_repos (app_id, remote_url, auth_kind)
select id, git_remote_url, git_auth_kind
  from amux.apps
 where git_remote_url is not null
on conflict (app_id) do update
   set remote_url = excluded.remote_url,
       auth_kind = excluded.auth_kind,
       updated_at = now()
 where (amux.app_forge_repos.remote_url, amux.app_forge_repos.auth_kind)
       is distinct from (excluded.remote_url, excluded.auth_kind);

-- Touches only deployed_revision: no trigger on apps fires for that column.
update amux.apps
   set deployed_revision = git_commit_sha
 where git_commit_sha is not null
   and deployed_revision is null;
