-- App platform P2.2 — the Cloud API reads permissions from the platform model.
--
-- docs/specs/2026-11-25-app-platform-p2-de-team.md §3 (P2.2) and §6.
--
-- 1. amux.caller_app_access(app): the caller's level on one app, computed only
--    from what P2.1 added — apps.created_by_user_id, amux.app_grants (user
--    principals) and amux.app_delegations — and the app's org. P2.3's RLS
--    reuses it.
-- 2. Slugs become unique per org (Q2). A collision stops the migration
--    instead of renaming anything: the slug is part of the app's public
--    hostname and its data schema name.
--
-- Writes are unchanged: the legacy tables stay the source and P2.1's triggers
-- keep the platform tables in step, so rolling the Cloud API back is safe.

-- ── 1) the rule ─────────────────────────────────────────────────────────────
--
-- Every path requires the caller to be a member of the app's org (a member of
-- any team in it — the tenant). Within it:
--
--   creator                       → admin
--   a user grant                  → its level
--   a delegation (agent → owner)  → the owner's level from the two rules above;
--                                   `delegated` is true when that is what won
--
-- Org grants (team visibility, P2.1) are not a level: they let org members see
-- the app and download its code and nothing else, exactly what team visibility
-- did (P2.2 decision). They are read where visibility is decided, not here.
--
-- Delegation counts only inside an org the agent itself belongs to (P2.2
-- decision): the owner's grants elsewhere never travel with the agent.
--
-- No row means no access — including an app that does not exist or that sits
-- in another org, so the function is not a probe for app ids.

create or replace function amux.caller_app_access(p_app_id uuid)
returns table (level text, delegated boolean, is_creator boolean)
language sql
stable
security definer
set search_path = amux, public, auth
as $$
  with app as (
    select a.id, a.org_id, a.created_by_user_id
      from amux.apps a
     where a.id = p_app_id
       and auth.uid() is not null
       and exists (
         select 1
           from amux.actors x
           join amux.teams t on t.id = x.team_id
          where x.user_id = auth.uid()
            and t.oid = a.org_id
       )
  ),
  direct as (
    select max(r) as r from (
      select 3 as r from app where app.created_by_user_id = auth.uid()
      union all
      select case g.level when 'admin' then 3 when 'write' then 2 when 'read' then 1 end
        from amux.app_grants g
       where g.app_id = p_app_id
         and g.principal_user_id = auth.uid()
    ) s
  ),
  via as (
    select max(r) as r from (
      select 3 as r
        from app
        join amux.app_delegations d on d.principal_user_id = app.created_by_user_id
       where d.delegate_user_id = auth.uid()
      union all
      select case g.level when 'admin' then 3 when 'write' then 2 when 'read' then 1 end
        from amux.app_delegations d
        join amux.app_grants g on g.principal_user_id = d.principal_user_id
       where d.delegate_user_id = auth.uid()
         and g.app_id = p_app_id
    ) s
  ),
  out as (
    select
      case greatest(coalesce(direct.r, 0), coalesce(via.r, 0))
        when 3 then 'admin' when 2 then 'write' when 1 then 'read'
      end as level,
      coalesce(via.r, 0) > coalesce(direct.r, 0) as delegated,
      coalesce(app.created_by_user_id = auth.uid(), false) as is_creator
    from app, direct, via
  )
  select level, delegated, is_creator from out where level is not null
$$;

comment on function amux.caller_app_access(uuid) is
  'The caller''s level on an app from the platform model (creator, user grants, delegations inside the app''s org). No row = no access. P2.2.';

revoke all on function amux.caller_app_access(uuid) from public, anon;
grant execute on function amux.caller_app_access(uuid) to authenticated, service_role;

-- ── 2) slugs unique per org ─────────────────────────────────────────────────

do $$
declare
  v_collisions text;
begin
  select string_agg(format('org %s slug %s (%s apps)', org_id, slug, n), '; ')
    into v_collisions
    from (
      select org_id, slug, count(*) as n
        from amux.apps
       group by org_id, slug
      having count(*) > 1
    ) c;
  if v_collisions is not null then
    raise exception 'app slugs collide within an org: %', v_collisions
      using hint = 'Rename by hand (the slug is in the app''s hostname and data schema), then re-run.';
  end if;
end
$$;

create unique index if not exists apps_org_slug_uniq on amux.apps (org_id, slug);
