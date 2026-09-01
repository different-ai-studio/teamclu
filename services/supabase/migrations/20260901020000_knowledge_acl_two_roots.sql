-- Widen the knowledge ACL prefix constraint to both synced roots.
--
-- The synced tree now has two fixed roots under `shared/team-sync/`:
-- `documents/` (files with an owner) and `knowledge/` (shared consensus). See
-- docs/specs/2026-09-01-team-sync-two-roots-design.md.
--
-- ## Why this WIDENS rather than repointing at documents only
--
-- Only documents gets a permissions entry point in the UI. That split is
-- editorial — it is about what the two directories are for — not technical, and
-- an editorial rule should not be enforced by a database constraint.
--
-- Pointing this at `documents/%` would mean that the first time somebody has a
-- genuinely sensitive knowledge subfolder, satisfying them costs a migration.
-- The UI withholding the button is the whole of the policy; the constraint's
-- job is only to keep rules inside the synced tree, which is what it still does.
--
-- Both halves still matter and are unchanged in spirit:
--   * the prefix must name one of the synced roots, so a rule cannot be written
--     against a path the sync engine will never carry;
--   * it must end in `/`, which is what stops `knowledge/hr` from also covering
--     `knowledge/hr-public/`. The SQL LIKE filter and the daemon's in-process
--     matcher both depend on that trailing slash.
--
-- Widening only: every prefix accepted before is still accepted, so no existing
-- row can be invalidated by this.

ALTER TABLE amux.amuxc_path_acl
    DROP CONSTRAINT IF EXISTS amuxc_path_acl_prefix_shape;

ALTER TABLE amux.amuxc_path_acl
    ADD CONSTRAINT amuxc_path_acl_prefix_shape CHECK (
        (path_prefix LIKE 'knowledge/%' OR path_prefix LIKE 'documents/%')
        AND path_prefix LIKE '%/'
    );

COMMENT ON CONSTRAINT amuxc_path_acl_prefix_shape ON amux.amuxc_path_acl IS
  'Rule prefixes must name one of the two synced roots and end in "/". The trailing slash is what makes prefix matching land on a path boundary. Both roots are accepted here on purpose: only documents gets a UI entry point, and that is an editorial policy rather than something worth freezing into a constraint.';
