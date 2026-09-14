-- Exact workspace identity is (team_id, path_key), not (team_id, agent_id, path).
-- path_key is a string-normalized absolute path (trim, trailing slash, `.` / `..`);
-- the application writes it. No realpath / symlink expansion.

alter table amux.workspaces
  add column if not exists path_key text;

update amux.workspaces
set path_key = nullif(regexp_replace(trim(both from path), '/+$', ''), '')
where path is not null
  and path_key is null;

-- Keep one live row per (team, path_key); archive extras so the unique index can land.
with ranked as (
  select
    id,
    row_number() over (
      partition by team_id, path_key
      order by created_at asc nulls last, id asc
    ) as rn
  from amux.workspaces
  where archived = false
    and path_key is not null
)
update amux.workspaces w
set archived = true
from ranked r
where w.id = r.id
  and r.rn > 1;

create unique index if not exists workspaces_team_path_unique
  on amux.workspaces (team_id, path_key)
  where archived = false
    and path_key is not null;

comment on column amux.workspaces.path_key is
  'Normalized absolute path used for idempotent workspace upsert. Not a realpath.';
