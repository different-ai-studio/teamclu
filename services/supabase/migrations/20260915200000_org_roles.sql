-- Org-scoped RBAC: public.roles / public.roles_users.
-- Seed system roles per org, backfill from amux.team_members.role,
-- rewrite amux.current_team_role from roles_users only (no team_members.role
-- fallback — callers without roles_users rows get NULL).

-- ── 1) Tables (from docs/database/*.sql) ─────────────────────────────────────

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

-- store_id: no FK to stores — TeamClu has no public.stores mirror.
CREATE TABLE IF NOT EXISTS public.roles_users (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
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

-- ── 2) Partial unique (NULL store_id) ───────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_users_user_role_null_store
    ON public.roles_users (user_id, role_id) WHERE store_id IS NULL;

-- ── Helpers (before RLS policies that call them) ────────────────────────────

CREATE OR REPLACE FUNCTION amux.has_org_role_code(p_team_id uuid, p_code text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'auth', 'amux'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM amux.teams t
    JOIN public.roles_users ru
      ON ru.org_id = t.oid
     AND ru.user_id = auth.uid()
     AND ru.status = 'active'
    JOIN public.roles r
      ON r.id = ru.role_id
     AND r.status = 'active'
    WHERE t.id = p_team_id
      AND r.code = p_code
  );
$$;

REVOKE ALL ON FUNCTION amux.has_org_role_code(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION amux.has_org_role_code(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION amux.has_org_role_code(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION amux.is_org_role_manager(p_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'auth', 'amux'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.roles_users ru
    JOIN public.roles r
      ON r.id = ru.role_id
     AND r.status = 'active'
    WHERE ru.org_id = p_org_id
      AND ru.user_id = auth.uid()
      AND ru.status = 'active'
      AND r.code IN ('owner', 'admin')
  );
$$;

REVOKE ALL ON FUNCTION amux.is_org_role_manager(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION amux.is_org_role_manager(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION amux.is_org_role_manager(uuid) TO service_role;

CREATE OR REPLACE FUNCTION amux.is_org_member(p_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'auth', 'amux'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM amux.teams t
    WHERE t.oid = p_org_id
      AND amux.is_team_member(t.id)
  );
$$;

REVOKE ALL ON FUNCTION amux.is_org_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION amux.is_org_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION amux.is_org_member(uuid) TO service_role;

-- ── 3) RLS ──────────────────────────────────────────────────────────────────

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roles_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS roles_select_org_member ON public.roles;
CREATE POLICY roles_select_org_member ON public.roles
  FOR SELECT TO authenticated
  USING (amux.is_org_member(org_id));

DROP POLICY IF EXISTS roles_write_org_manager ON public.roles;
CREATE POLICY roles_write_org_manager ON public.roles
  FOR ALL TO authenticated
  USING (amux.is_org_role_manager(org_id))
  WITH CHECK (amux.is_org_role_manager(org_id));

DROP POLICY IF EXISTS roles_users_select_org_member ON public.roles_users;
CREATE POLICY roles_users_select_org_member ON public.roles_users
  FOR SELECT TO authenticated
  USING (amux.is_org_member(org_id));

DROP POLICY IF EXISTS roles_users_write_org_manager ON public.roles_users;
CREATE POLICY roles_users_write_org_manager ON public.roles_users
  FOR ALL TO authenticated
  USING (amux.is_org_role_manager(org_id))
  WITH CHECK (amux.is_org_role_manager(org_id));

-- ── 4) Seed: four system roles per org ──────────────────────────────────────

CREATE OR REPLACE FUNCTION amux.ensure_org_system_roles(p_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'amux'
AS $$
BEGIN
  IF p_org_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.roles (name, code, description, org_id, is_system, status, sort)
  VALUES
    ('拥有者', 'owner',   '系统角色：拥有者', p_org_id, true, 'active', 10),
    ('管理员', 'admin',   '系统角色：管理员', p_org_id, true, 'active', 20),
    ('成员',   'member',  '系统角色：成员',   p_org_id, true, 'active', 30),
    ('财务',   'finance', '系统角色：财务',   p_org_id, true, 'active', 40)
  ON CONFLICT (org_id, code) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION amux.ensure_org_system_roles(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION amux.ensure_org_system_roles(uuid) TO service_role;

CREATE OR REPLACE FUNCTION amux.trg_orgs_ensure_system_roles()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'amux'
AS $$
BEGIN
  PERFORM amux.ensure_org_system_roles(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_orgs_ensure_system_roles ON public.orgs;
CREATE TRIGGER trg_orgs_ensure_system_roles
  AFTER INSERT ON public.orgs
  FOR EACH ROW
  EXECUTE FUNCTION amux.trg_orgs_ensure_system_roles();

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT id FROM public.orgs LOOP
    PERFORM amux.ensure_org_system_roles(r.id);
  END LOOP;
END;
$$;

-- ── 5) Backfill from team_members ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION amux.backfill_roles_users_from_team_members()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'amux', 'auth'
AS $$
BEGIN
  INSERT INTO public.roles_users (user_id, role_id, org_id, status, store_id, is_primary)
  SELECT DISTINCT
    a.user_id,
    r.id,
    t.oid,
    'active',
    -- Typed: a bare NULL in a SELECT list resolves to text and the INSERT
    -- fails with "column store_id is of type uuid but expression is of type text".
    NULL::uuid,
    false
  FROM amux.team_members tm
  JOIN amux.teams t ON t.id = tm.team_id
  JOIN amux.actors a ON a.id = tm.member_id
  JOIN public.users u ON u.id = a.user_id
  JOIN public.roles r
    ON r.org_id = t.oid
   AND r.code = lower(tm.role)
   AND r.is_system = true
  WHERE a.user_id IS NOT NULL
    AND t.oid IS NOT NULL
    AND tm.role IS NOT NULL
  ON CONFLICT DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION amux.backfill_roles_users_from_team_members() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION amux.backfill_roles_users_from_team_members() TO service_role;

SELECT amux.backfill_roles_users_from_team_members();

-- ── 6) current_team_role from roles_users only ───────────────────────────────
-- Privilege order: owner > admin > finance > member > other.
-- No COALESCE to team_members.role (option A). Without roles_users, returns NULL;
-- legacy pgTAP fixtures that only set team_members.role are Task 4/11.

CREATE OR REPLACE FUNCTION amux.current_team_role(target_team_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'auth', 'amux'
AS $$
  SELECT r.code
  FROM amux.teams t
  JOIN public.roles_users ru
    ON ru.org_id = t.oid
   AND ru.user_id = auth.uid()
   AND ru.status = 'active'
  JOIN public.roles r ON r.id = ru.role_id AND r.status = 'active'
  WHERE t.id = target_team_id
  ORDER BY CASE r.code
    WHEN 'owner' THEN 1
    WHEN 'admin' THEN 2
    WHEN 'finance' THEN 3
    WHEN 'member' THEN 4
    ELSE 5
  END
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION amux.current_team_role(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION amux.current_team_role(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION amux.current_team_role(uuid) TO service_role;

-- ── 7) team_members.role nullable (do not DROP) ─────────────────────────────

ALTER TABLE amux.team_members ALTER COLUMN role DROP NOT NULL;

-- ── 8) Grants + audit triggers ──────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.roles TO authenticated;
GRANT ALL ON TABLE public.roles TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.roles_users TO authenticated;
GRANT ALL ON TABLE public.roles_users TO service_role;

DROP TRIGGER IF EXISTS trg_roles_update_audit ON public.roles;
CREATE TRIGGER trg_roles_update_audit
  BEFORE UPDATE ON public.roles
  FOR EACH ROW
  EXECUTE FUNCTION amux.update_audit_columns();

DROP TRIGGER IF EXISTS trg_roles_users_update_audit ON public.roles_users;
CREATE TRIGGER trg_roles_users_update_audit
  BEFORE UPDATE ON public.roles_users
  FOR EACH ROW
  EXECUTE FUNCTION amux.update_audit_columns();
