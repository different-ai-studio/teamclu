-- =====================================================
-- roles_users (public) — user ↔ role assignments
-- Agreed DDL from saas-mono / product handoff.
-- This round: always write store_id = NULL, is_primary = false,
-- expires_at = NULL. Always set org_id from teams.oid.
--
-- store_id is UUID without a stores FK: TeamClu has no public.stores
-- mirror; saas-mono keeps REFERENCES stores(id) ON DELETE CASCADE.
-- =====================================================
CREATE TABLE IF NOT EXISTS public.roles_users (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    -- auth.users, not public.users as in saas-mono: every consumer compares
    -- against auth.uid() / amux.actors.user_id. See the migration header.
    user_id UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    role_id UUID NOT NULL REFERENCES public.roles (id) ON DELETE RESTRICT,
    store_id UUID,
    org_id UUID NOT NULL DEFAULT '5f7cb659-7302-4465-85b1-68a64bb3322e'::UUID
        REFERENCES public.orgs (id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'active',
    is_primary BOOLEAN NOT NULL DEFAULT false,
    expires_at TIMESTAMPTZ,
    created_by UUID DEFAULT auth.uid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by UUID DEFAULT auth.uid(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_note TEXT,
    CONSTRAINT unique_user_role_store UNIQUE (user_id, role_id, store_id),
    CONSTRAINT check_expires_at CHECK (expires_at IS NULL OR expires_at > created_at),
    CONSTRAINT check_user_role_status CHECK (status IN ('active', 'inactive'))
);

CREATE INDEX IF NOT EXISTS idx_roles_users_user_id ON public.roles_users (user_id);
CREATE INDEX IF NOT EXISTS idx_roles_users_org_id ON public.roles_users (org_id);
CREATE INDEX IF NOT EXISTS idx_roles_users_user_org_status
    ON public.roles_users (user_id, org_id, status) WHERE status = 'active';

-- PostgreSQL UNIQUE allows multiple NULLs in store_id; enforce one
-- assignment per (user, role) when store-scoped rows are unused.
CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_users_user_role_null_store
    ON public.roles_users (user_id, role_id) WHERE store_id IS NULL;
