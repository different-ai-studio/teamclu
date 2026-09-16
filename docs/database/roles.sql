-- =====================================================
-- roles (public) — org role catalog
-- Agreed DDL from saas-mono / product handoff.
-- TeamClu writers MUST set org_id explicitly from teams.oid;
-- do not rely on the DEFAULT UUID below.
-- =====================================================
CREATE TABLE IF NOT EXISTS public.roles (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    description TEXT,
    org_id UUID NOT NULL DEFAULT '5f7cb659-7302-4465-85b1-68a64bb3322e'::UUID
        REFERENCES public.orgs(id) ON DELETE CASCADE,
    is_system BOOLEAN NOT NULL DEFAULT false,
    status TEXT NOT NULL DEFAULT 'active',
    parent_role_id UUID REFERENCES public.roles(id) ON DELETE SET NULL,
    sort INTEGER NOT NULL DEFAULT 50,
    created_by UUID DEFAULT auth.uid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by UUID DEFAULT auth.uid(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_note TEXT,
    CONSTRAINT unique_role_code_per_org UNIQUE (org_id, code),
    CONSTRAINT check_role_code_format CHECK (code ~ '^[a-z][a-z0-9_]*$'),
    CONSTRAINT check_role_status CHECK (status IN ('active', 'inactive'))
);

CREATE INDEX IF NOT EXISTS idx_roles_org_id ON public.roles (org_id);
CREATE INDEX IF NOT EXISTS idx_roles_code ON public.roles (code);
CREATE INDEX IF NOT EXISTS idx_roles_parent_role_id ON public.roles (parent_role_id);
CREATE INDEX IF NOT EXISTS idx_roles_org_status ON public.roles (org_id, status);
