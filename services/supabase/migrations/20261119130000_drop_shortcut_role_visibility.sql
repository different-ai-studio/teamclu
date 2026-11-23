-- Drop the half-built "shortcuts visible by role" feature: amux.team_roles,
-- amux.team_member_roles, amux.permission_roles, and the three functions that
-- read or write them.
--
-- Nothing reached it end to end. No component called the desktop store's
-- setVisibleRoles / loadTeamRoles; the client POSTed to a path FC never served
-- (/v1/shortcuts/set-visible-roles, not PUT /v1/shortcuts/:id/visible-roles);
-- and team_member_roles had no writer outside pgTAP, so a shortcut given a
-- role restriction would have vanished for every ordinary member. The FC
-- routes, repository methods and client calls go in the same change.
--
-- THIS IS A ONE-WAY DOOR ON DATA. Before applying it to a live database, run
-- (read-only) services/supabase/manual/drop_shortcut_role_visibility_precheck.sql.
-- belayo read 0 / 0 / 0 rows on 2026-11-19.
--
-- The block below refuses to drop anything while any of the three tables has
-- rows, so a database where somebody did use it fails this migration loudly
-- instead of losing the rows. If that happens: export the rows, decide, and
-- either delete them or withhold this file.
--
-- Dependents, handled explicitly (no CASCADE):
--
--   member_can_see_shortcut — the shortcuts_select_team RLS policy calls it.
--     It called member_can_access_permission, which returned true whenever a
--     shortcut's permission had no permission_roles rows. With the guard below
--     proving there are none, every team shortcut is visible to every team
--     member today. The rewrite keeps exactly that: team scope ⇒
--     is_team_member. Personal scope is unchanged.
--   member_can_access_permission — only caller is the function above.
--   shortcut_set_visible_roles — the only writer of permission_roles.
--   team_member_set_roles — the only writer of team_member_roles.
--
-- amux.permissions stays: shortcut_create still writes one row per team
-- shortcut and a trigger removes it on delete; it carries no role data.

do $guard$
declare
  v_table text;
  v_rows  bigint;
begin
  foreach v_table in array array['permission_roles', 'team_member_roles', 'team_roles'] loop
    if to_regclass('amux.' || v_table) is null then
      continue;
    end if;
    execute format('select count(*) from amux.%I', v_table) into v_rows;
    if v_rows > 0 then
      raise exception
        'amux.% still has % row(s); export them and decide before dropping (see this migration''s header)',
        v_table, v_rows
        using errcode = 'P0001';
    end if;
  end loop;
end
$guard$;

-- Same signature, attributes and search_path as the baseline definition, so
-- the policy that calls it is untouched and existing grants carry over.
create or replace function amux.member_can_see_shortcut(target_shortcut_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'app'
as $$
  with sc as (
    select scope, owner_member_id, team_id from amux.shortcuts where id = target_shortcut_id
  )
  select case
    when (select scope from sc) = 'personal'
      then (select owner_member_id from sc) = amux.current_member_id()
    when (select scope from sc) = 'team'
      then amux.is_team_member((select team_id from sc))
  end
$$;

drop function if exists amux.member_can_access_permission(uuid);
drop function if exists amux.shortcut_set_visible_roles(uuid, uuid[]);
drop function if exists amux.team_member_set_roles(uuid, uuid, uuid[]);

-- Children first: permission_roles and team_member_roles reference team_roles.
-- No CASCADE: if anything else (a view, a foreign key from another table) has
-- come to depend on them, fail here rather than silently drop that too. Their
-- own policies, indexes and constraints go with them.
drop table if exists amux.permission_roles;
drop table if exists amux.team_member_roles;
drop table if exists amux.team_roles;
