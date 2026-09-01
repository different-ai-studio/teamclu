-- The knowledge ACL tables were created without service_role GRANTs.
--
-- Same failure the marketplace catalog hit in
-- 20260821100000_marketplace_service_role_grants.sql, and the lesson in that
-- file's header is exactly the one that was missed here: **BYPASSRLS alone is
-- not enough — table privileges are still required.** `service_role` bypassing
-- RLS says nothing about whether Postgres will let it touch the table at all.
--
-- The blast radius was not limited to the new feature. `/sync/manifest` resolves
-- the caller's ACL view on every call, including for the teams — currently all
-- of them — that have no rules at all, and that resolution fails closed by
-- design. So a missing GRANT turned into `permission denied for table
-- amuxc_path_acl` on every manifest request, and knowledge sync stopped for the
-- whole deployment until this was granted by hand on 2026-09-01.
--
-- Two things worth carrying forward:
--   * `amux` has no ALTER DEFAULT PRIVILEGES backstop. A new table reachable
--     from FC needs its grants written out, in the same migration that creates
--     it.
--   * Failing closed is still right for an access-control lookup, but it means
--     a provisioning mistake in that lookup is an outage rather than a
--     degraded feature. It deserves more scrutiny before deploy than a table
--     only the new feature reads.
--
-- Deliberately NOT granted to `authenticated`: `path_prefix` is a directory
-- name, and the design keeps the rule list from members entirely. These tables
-- carry RLS with no policy for the same reason; withholding the grant as well
-- means a future policy added by accident still cannot leak them.
--
-- Idempotent — `grant` on an already-granted privilege is a no-op, so this is
-- safe on the box where it was applied by hand and on a fresh install where
-- 20260901000000 has been patched to include it.

grant select, insert, update, delete on amux.amuxc_path_acl to service_role;
grant select, insert, update, delete on amux.amuxc_path_acl_grants to service_role;
grant select, insert, delete on amux.amuxc_access_log to service_role;
grant usage, select on sequence amux.amuxc_access_log_id_seq to service_role;
