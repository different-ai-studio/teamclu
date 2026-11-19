-- Drop five baseline RPCs that nothing calls.
--
-- A repo-wide search (services/fc, services/ai-gateway, apps/daemon,
-- apps/desktop, packages/app, apps/ios, apps/expo, the browser extension,
-- scripts/, deploy/, every later migration, trigger, view and RLS policy)
-- finds no caller for any of them; only the definitions and, for the two share
-- functions, pgTAP. Dropping a function loses no data — the bodies stay in the
-- baseline and git history.
--
--   enable_team_share / disable_team_share
--     The one-shot share-mode switch. CLAUDE.md: no code reads or writes
--     teams.share_mode any more. The column and its enum stay (an in-use enum
--     value cannot be dropped, and dropping the column is a one-way door).
--   add_gateway_session_participant
--     Primary-agent helper from the pre-Cloud-API gateway; no daemon, FC or
--     client code names it.
--   ensure_org_default_team
--     Superseded by amux.ensure_org_public_team (20260817030000), which says
--     so in its own header.
--   bind_phone_to_account
--     Its only route, POST /v1/account/bind-phone, is a permanent 410
--     (services/fc/src/lib/routes/account.ts); it also wrote into DEFAULT_ORG,
--     which TeamClu no longer does.
--
-- Deliberately NOT dropped although they have no code caller:
--   team_member_set_roles — the only writer of amux.team_member_roles, which
--     the live shortcuts_select_team RLS policy reads through
--     member_can_see_shortcut -> member_can_access_permission.
--   can_prompt_agent — the only SQL statement of the "prompt + visibility"
--     rule; 002_rls and 009_agent_visibility pin agent visibility through it.
--
-- `if exists` keeps this a no-op on a database where any of them is already
-- gone. Runs as the migration role, which owns these functions (supabase_admin
-- in CI, postgres on self-host).

drop function if exists amux.enable_team_share(uuid, amux.team_share_mode, text, text, text);
drop function if exists amux.disable_team_share(uuid);
drop function if exists amux.add_gateway_session_participant(uuid, uuid);
drop function if exists amux.ensure_org_default_team(uuid, text);
drop function if exists amux.bind_phone_to_account(text, text, uuid);
