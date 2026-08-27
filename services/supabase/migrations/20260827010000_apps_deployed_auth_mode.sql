-- Record which auth_mode the LIVE function was actually deployed with.
--
-- The OAuth env is injected at finalizeDeploy (buildPlatformOAuthEnv), so
-- changing `auth_mode` on an already-live app does nothing to the running
-- function: the site keeps whatever gate it was deployed with until the next
-- deploy. The UI has to say so — a user who has just switched an app to
-- "requires login" will otherwise believe it is protected while it is still
-- fully public. Design §7.4 calls that out as a security expectation, not a
-- cosmetic one.
--
-- Holding the pending state in the desktop's in-memory store did not survive a
-- reload, another device, or a second admin. This column makes it a property of
-- the row: pending ⇔ fc_status = 'live' AND auth_mode <> deployed_auth_mode.

alter table amux.apps
  add column if not exists deployed_auth_mode text;

comment on column amux.apps.deployed_auth_mode is
  'auth_mode baked into the currently deployed FC function; NULL before the first successful finalize. Compare with auth_mode to detect a change that has not been deployed yet.';

-- Backfill live rows as "already deployed with their current mode". We have no
-- deploy history to consult, and the alternative — leaving NULL — would light up
-- a "pending redeploy" warning on every existing live app at once, training
-- users to ignore the one warning that matters.
update amux.apps
   set deployed_auth_mode = auth_mode
 where fc_status = 'live'
   and deployed_auth_mode is null;
