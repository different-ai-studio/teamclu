-- Record which `type` the LIVE function was actually deployed with.
--
-- `type` became editable (PATCH /v1/apps/:appId). What it decides on the server
-- is made once, at finalizeDeploy: `needsDatabase(type)` provisions the app's
-- Postgres schema and injects DATABASE_URL, or does not. So changing `type` on
-- an already-live app does nothing to the running function until the next
-- deploy — switching TO data_app does not give it a database yet, and switching
-- AWAY does not take DATABASE_URL away yet (the next deploy will; the schema
-- and its data are kept either way).
--
-- Exactly the reasoning behind `deployed_auth_mode`
-- (20260827010000_apps_deployed_auth_mode.sql): the pending state is a property
-- of the row, readable by every client, every device and every admin —
-- pending ⇔ fc_status = 'live' AND deployed_type IS NOT NULL AND the two types
-- differ in whether they get a database (typeChangeNeedsRedeploy, used by
-- mapApp in services/fc).
--
-- Guarded with an existence check rather than `add column if not exists`: that
-- form checks ownership BEFORE it checks whether the column is there, so on a
-- deployment whose migrate role does not own amux.apps it fails with `must be
-- owner of table apps` even when there is nothing to do. CI runs as
-- supabase_admin and self-host as postgres, so the two disagree on ownership
-- and CI cannot see the failure. The comment is inside the same guard for the
-- same reason: COMMENT ON COLUMN is owner-only too.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'amux' and table_name = 'apps' and column_name = 'deployed_type'
  ) then
    alter table amux.apps add column deployed_type text;

    comment on column amux.apps.deployed_type is
      'type baked into the currently deployed FC function (it decides whether the function got a database); NULL before the first successful finalize. Compare with type to detect a change that has not been deployed yet.';
  end if;
end $$;

-- Backfill live rows as "already deployed with their current type". We have no
-- deploy history to consult, and the alternative — leaving NULL — would read as
-- "unknown", which the server already treats as not pending; filling it in is
-- what makes a type change made AFTER this migration show up as pending at all.
-- Nothing could have changed `type` before this migration (PATCH ignored it), so
-- for a live row the current type is exactly what was deployed.
update amux.apps
   set deployed_type = type
 where fc_status = 'live'
   and deployed_type is null;

notify pgrst, 'reload schema';
