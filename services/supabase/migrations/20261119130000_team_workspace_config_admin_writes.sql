-- team_workspace_config: only a team owner or admin may write it.
--
-- The row carries the team's AI gateway (llm_base_url / llm_models /
-- llm_enabled), and every agent in the team sends its prompts to whatever URL
-- is stored there. The INSERT and UPDATE policies only required
-- `is_team_member`, so any member could point the whole team's traffic at a
-- server of their choosing, either through `PUT /v1/teams/:id/llm-config` or
-- straight through PostgREST with their own token.
--
-- FC now checks owner/admin before that route writes; these policies make the
-- database say the same thing, so the FC check is not the only line.
--
-- Unaffected writers: every SQL function that updates this table
-- (amuxc_complete_upload, amuxc_complete_delete, set_team_sync_mode, the
-- create-team / bootstrap paths) is SECURITY DEFINER, and FC's sync paths use
-- the service-role client. Reads stay open to every member: the daemon and
-- clients read the gateway config from here.

drop policy if exists team_workspace_config_insert_if_team_member on amux.team_workspace_config;
drop policy if exists team_workspace_config_update_if_team_member on amux.team_workspace_config;

create policy team_workspace_config_insert_if_team_admin
  on amux.team_workspace_config
  for insert to authenticated
  with check (amux.is_team_admin_or_owner(team_id));

create policy team_workspace_config_update_if_team_admin
  on amux.team_workspace_config
  for update to authenticated
  using (amux.is_team_admin_or_owner(team_id))
  with check (amux.is_team_admin_or_owner(team_id));
