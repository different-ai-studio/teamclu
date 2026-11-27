-- App platform P3.1 — TeamClu reads its fields of an app from app_links.
--
-- docs/specs/2026-11-26-app-platform-p3-retire-legacy.md §2.1.
--
-- `GET /v1/apps?teamId=` now filters through the app's link
-- (`apps?select=…,app_links!inner(team_id)&app_links.team_id=eq.…`) instead of
-- apps.team_id, which P3.4 drops. PostgREST runs that embed with the caller's
-- token, so the caller must be able to read the link of every app they see —
-- and no others: the link names the team and workspace.
--
-- The rest of what TeamClu reads for an app — `visibility` (an org grant on
-- it) and the caller's own grants (`relationship: invited`, and who invited
-- them) — is read the same way, with the caller's token, so app_grants gets
-- the read rule app_member_access has (20261126200000): your own rows, the org
-- grants of apps you see, and every row of an app you created.
--
-- DDL only; dropping the policies and the grants rolls it back.

drop policy if exists app_links_select_if_visible on amux.app_links;
create policy app_links_select_if_visible on amux.app_links
  for select to authenticated
  using (app_id in (select app_id from amux.caller_apps()));

grant select on amux.app_links to authenticated;

drop policy if exists app_grants_select on amux.app_grants;
create policy app_grants_select on amux.app_grants
  for select to authenticated
  using (
    principal_user_id = (select auth.uid())
    or (principal_org_id is not null and app_id in (select app_id from amux.caller_apps()))
    or app_id in (select app_id from amux.caller_apps() where is_creator)
  );

grant select on amux.app_grants to authenticated;
