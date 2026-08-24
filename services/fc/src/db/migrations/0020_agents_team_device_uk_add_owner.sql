-- Mirrors services/supabase/migrations/20260824120000_agents_team_device_uk_add_owner.sql
--
-- The index was (team_id, device_id) — one agent per team+device regardless of
-- owner. But findAgentForDevice / findOwned both filter on owner_member_id,
-- so a device that already had an agent owned by another account would miss
-- the existing row, try to INSERT a second one, and hit:
--   duplicate key value violates unique agents_team_device_uk
--
-- Now (team_id, device_id, owner_member_id) — one agent per account per device.
drop index if exists "agents_team_device_uk";
--> statement-breakpoint
create unique index if not exists "agents_team_device_uk"
  on "agents" ("team_id", "device_id", "owner_member_id") where "device_id" is not null;
