-- Document library role grants.
-- Design: docs/specs/2026-10-14-document-library-role-access-design.md
--
-- A path-acl row is either granted to actors (amuxc_path_acl_grants) or to
-- org roles (this table). Sync reads both. Prefix names stay sensitive, so
-- this table matches its parent: RLS forced on, no policy, no grant to
-- authenticated. service_role is granted here, in the same migration —
-- BYPASSRLS without a table grant fails closed and stops every sync manifest.

CREATE TABLE amux.amuxc_path_acl_role_grants (
    acl_id uuid NOT NULL,
    role_id uuid NOT NULL,
    granted_by uuid NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT amuxc_path_acl_role_grants_pkey PRIMARY KEY (acl_id, role_id)
);

ALTER TABLE ONLY amux.amuxc_path_acl_role_grants
    ADD CONSTRAINT amuxc_path_acl_role_grants_acl_id_fkey
    FOREIGN KEY (acl_id) REFERENCES amux.amuxc_path_acl(id) ON DELETE CASCADE;

ALTER TABLE ONLY amux.amuxc_path_acl_role_grants
    ADD CONSTRAINT amuxc_path_acl_role_grants_role_id_fkey
    FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE RESTRICT;

ALTER TABLE ONLY amux.amuxc_path_acl_role_grants
    ADD CONSTRAINT amuxc_path_acl_role_grants_granted_by_fkey
    FOREIGN KEY (granted_by) REFERENCES amux.actors(id) ON DELETE RESTRICT;

CREATE INDEX idx_amuxc_path_acl_role_grants_role
    ON amux.amuxc_path_acl_role_grants USING btree (role_id);

ALTER TABLE amux.amuxc_path_acl_role_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY amux.amuxc_path_acl_role_grants FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE amux.amuxc_path_acl_role_grants IS
  'Org roles allowed to sync a document-library prefix. Owner is always stored. RLS with no policy: the role list names the folder.';

GRANT SELECT, INSERT, UPDATE, DELETE ON amux.amuxc_path_acl_role_grants TO service_role;
