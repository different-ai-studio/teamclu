-- Knowledge path ACL — per-directory access control for the team knowledge vault.
--
-- Design: docs/specs/2026-08-31-knowledge-path-acl-design.md
--
-- Facts for operators and reviewers:
--
-- - Whitelist semantics (design D5): a prefix that HAS a row in amuxc_path_acl
--   is closed to everyone except the actors listed in amuxc_path_acl_grants.
--   No rows at all -> the team is unrestricted and every query below is skipped
--   by the application, so teams that do not use this feature pay nothing.
--
-- - These tables deliberately have RLS ENABLED WITH NO POLICY. That is a
--   deny-all for `authenticated`, and it is intentional, not an omission:
--     1. /sync/* already runs under the service role and does its authorisation
--        in application code (services/fc/src/lib/sync-acl.ts), same as every
--        other sync guard.
--     2. path_prefix is itself sensitive. A "team members may read the rules"
--        policy would hand every member the list of restricted directory names
--        -- exactly what design decision D7 exists to prevent. There is no
--        correct permissive policy here, so there is no policy.
--   Anything that needs to read these tables goes through the Cloud API, which
--   checks owner/admin first.
--
-- - This does NOT make knowledge content confidential from the operator.
--   Content is stored in plaintext (ADR-0008). This is in-team access control.
--   Revocation stops distribution; it cannot recall copies already synced.

-- ---------------------------------------------------------------------------
-- amuxc_path_acl: one row per restricted prefix
-- ---------------------------------------------------------------------------
CREATE TABLE amux.amuxc_path_acl (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    path_prefix text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT amuxc_path_acl_pkey PRIMARY KEY (id),
    CONSTRAINT amuxc_path_acl_prefix_uniq UNIQUE (team_id, path_prefix),
    -- Both halves matter. `knowledge/` keeps rules inside the only synced
    -- prefix (mirrors ALLOWED_PREFIXES in the client path validator); the
    -- trailing slash is what stops `knowledge/hr` from matching
    -- `knowledge/hr-public/`. Matching is on segment boundaries because of it.
    CONSTRAINT amuxc_path_acl_prefix_shape CHECK (
        path_prefix LIKE 'knowledge/%' AND path_prefix LIKE '%/'
    )
);

ALTER TABLE ONLY amux.amuxc_path_acl
    ADD CONSTRAINT amuxc_path_acl_team_id_fkey
    FOREIGN KEY (team_id) REFERENCES amux.teams(id) ON DELETE CASCADE;

ALTER TABLE ONLY amux.amuxc_path_acl
    ADD CONSTRAINT amuxc_path_acl_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES amux.actors(id) ON DELETE RESTRICT;

CREATE INDEX idx_amuxc_path_acl_team ON amux.amuxc_path_acl USING btree (team_id);

ALTER TABLE amux.amuxc_path_acl ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY amux.amuxc_path_acl FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE amux.amuxc_path_acl IS
  'Restricted knowledge prefixes. Whitelist semantics: a prefix listed here is closed to every actor without a matching amuxc_path_acl_grants row. RLS enabled with no policy on purpose — prefix names are sensitive; reads go through the Cloud API under service role.';

-- ---------------------------------------------------------------------------
-- amuxc_path_acl_grants: who may see a restricted prefix
-- ---------------------------------------------------------------------------
CREATE TABLE amux.amuxc_path_acl_grants (
    acl_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    -- Reserved for the read-only axis (design D3). v1 code does not read this
    -- column: reading it would mean "read-only" is implemented, and it is not.
    -- Stored now because a migration later is more expensive than a column now.
    permissions character varying(32) DEFAULT 'a:m:d' NOT NULL,
    granted_by uuid NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT amuxc_path_acl_grants_pkey PRIMARY KEY (acl_id, actor_id)
);

ALTER TABLE ONLY amux.amuxc_path_acl_grants
    ADD CONSTRAINT amuxc_path_acl_grants_acl_id_fkey
    FOREIGN KEY (acl_id) REFERENCES amux.amuxc_path_acl(id) ON DELETE CASCADE;

ALTER TABLE ONLY amux.amuxc_path_acl_grants
    ADD CONSTRAINT amuxc_path_acl_grants_actor_id_fkey
    FOREIGN KEY (actor_id) REFERENCES amux.actors(id) ON DELETE CASCADE;

ALTER TABLE ONLY amux.amuxc_path_acl_grants
    ADD CONSTRAINT amuxc_path_acl_grants_granted_by_fkey
    FOREIGN KEY (granted_by) REFERENCES amux.actors(id) ON DELETE RESTRICT;

CREATE INDEX idx_amuxc_path_acl_grants_actor
    ON amux.amuxc_path_acl_grants USING btree (actor_id);

ALTER TABLE amux.amuxc_path_acl_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY amux.amuxc_path_acl_grants FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE amux.amuxc_path_acl_grants IS
  'Grants on restricted knowledge prefixes. Separate table rather than an array on amuxc_path_acl so granted_by/granted_at give an auditable grant history.';

-- ---------------------------------------------------------------------------
-- amuxc_access_log: audit trail for restricted content
-- ---------------------------------------------------------------------------
--
-- Only writes when a request touches a restricted prefix, so an unrestricted
-- team produces no rows at all. This is the thing the feature can actually
-- deliver -- revocation cannot recall a synced copy, but this answers "before
-- the grant was removed, who pulled it?".
--
-- Denials are logged too: a member repeatedly probing a directory they cannot
-- read is a signal worth keeping.
--
-- Retention is 180 days, enforced by an FC cron job. NOTE: the cron compose
-- profile is not enabled on self-host today, so in practice this is pruned by
-- hand until that ops ticket lands. Do not describe retention as automatic.
CREATE TABLE amux.amuxc_access_log (
    id bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
    team_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    path_prefix text NOT NULL,
    path text,
    action text NOT NULL,
    allowed boolean NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT amuxc_access_log_pkey PRIMARY KEY (id),
    CONSTRAINT amuxc_access_log_action_check CHECK (
        action IN ('manifest', 'download', 'upload', 'delete', 'versions')
    )
);

ALTER TABLE ONLY amux.amuxc_access_log
    ADD CONSTRAINT amuxc_access_log_team_id_fkey
    FOREIGN KEY (team_id) REFERENCES amux.teams(id) ON DELETE CASCADE;

ALTER TABLE ONLY amux.amuxc_access_log
    ADD CONSTRAINT amuxc_access_log_actor_id_fkey
    FOREIGN KEY (actor_id) REFERENCES amux.actors(id) ON DELETE CASCADE;

CREATE INDEX idx_amuxc_access_log_team_at
    ON amux.amuxc_access_log USING btree (team_id, at DESC);

CREATE INDEX idx_amuxc_access_log_prefix
    ON amux.amuxc_access_log USING btree (team_id, path_prefix, at DESC);

ALTER TABLE amux.amuxc_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY amux.amuxc_access_log FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE amux.amuxc_access_log IS
  'Access audit for restricted knowledge prefixes only; unrestricted traffic writes nothing. Denials are recorded as well. Retention 180 days, pruned manually until the FC cron profile is enabled on self-host.';
