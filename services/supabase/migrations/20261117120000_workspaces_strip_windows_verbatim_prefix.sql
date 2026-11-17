-- Repair workspace paths that a Windows amuxd registered in verbatim form.
--
-- amuxd canonicalized workspace paths with Rust's `Path::canonicalize`, which
-- on Windows returns a verbatim path (`\\?\C:\proj`). FC's path normalization
-- turned that into `/?/C:/proj`: a path that exists on no machine, so a runtime
-- started on such a workspace failed with WORKSPACE_PATH_UNAVAILABLE. Worse, the
-- string never matched the same folder registered in plain form (`C:/proj`, as
-- the desktop does), so FC inserted it as a second row for that folder.
--
-- amuxd now uses `dunce::canonicalize` and FC strips the prefix, so no new rows
-- are written this way. This fixes the ones already stored:
--
--   /?/C:/proj            -> C:/proj
--   /?/UNC/server/share   -> /server/share   (what FC makes of a plain UNC path)
--
-- A broken row whose fixed path already belongs to another live row in the
-- team (its "twin") cannot stay live: `workspaces_team_path_unique` allows one
-- live row per (team, path_key). Its references move to the twin, then it is
-- archived. References that cannot move because the twin already holds the
-- unique slot (one app per workspace, one skill install per workspace) stay
-- on the archived row, whose path is now valid, so they still resolve.
--
-- Idempotent: every step selects on the `/?/` prefix, which the last step
-- removes.

create temporary table _ws_verbatim as
select
  b.id,
  b.team_id,
  b.archived,
  case
    when b.path ~* '^/\?/UNC/' then '/' || substr(b.path, 8)
    else substr(b.path, 4)
  end as fixed_path
from amux.workspaces b
where b.path ~* '^/\?/([A-Za-z]:(/|$)|UNC/)';

-- The live row that already owns the fixed path in the same team, if any.
create temporary table _ws_twin as
select v.id as bad_id, g.id as twin_id
from _ws_verbatim v
join amux.workspaces g
  on g.team_id = v.team_id
 and g.id <> v.id
 and g.archived = false
 and g.path_key = v.fixed_path
where v.archived = false;

update amux.agents a
set default_workspace_id = t.twin_id
from _ws_twin t
where a.default_workspace_id = t.bad_id;

update amux.session_participants p
set workspace_id = t.twin_id
from _ws_twin t
where p.workspace_id = t.bad_id;

update amux.ideas i
set workspace_id = t.twin_id
from _ws_twin t
where i.workspace_id = t.bad_id;

update amux.apps x
set workspace_id = t.twin_id
from _ws_twin t
where x.workspace_id = t.bad_id
  and not exists (select 1 from amux.apps y where y.workspace_id = t.twin_id);

update amux.team_skill_installs s
set workspace_id = t.twin_id
from _ws_twin t
where s.workspace_id = t.bad_id
  and not exists (
    select 1
    from amux.team_skill_installs o
    where o.actor_id = s.actor_id
      and o.skill_id = s.skill_id
      and o.scope = s.scope
      and o.workspace_id = t.twin_id
  );

-- Archive first, so the twin's slot in the unique index is never contested.
update amux.workspaces w
set archived = true
from _ws_twin t
where w.id = t.bad_id;

update amux.workspaces w
set path = v.fixed_path,
    path_key = v.fixed_path
from _ws_verbatim v
where w.id = v.id;

drop table _ws_twin;
drop table _ws_verbatim;
