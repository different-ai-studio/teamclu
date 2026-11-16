CREATE TABLE amux.org_roles_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES public.roles(id) ON DELETE RESTRICT,
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  -- Retained to preserve the old document ACL distinction for imported grants.
  -- New collaboration grants always use NULL; this is not a Betly node.
  store_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  is_primary boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid(),
  updated_by uuid DEFAULT auth.uid(),
  updated_note text,
  UNIQUE NULLS NOT DISTINCT (user_id,role_id,store_id)
);
COMMENT ON TABLE amux.org_roles_users IS
  'TeamClu collaboration grants only. Never grants Betly employee or organization-node permissions.';
CREATE INDEX ON amux.org_roles_users(org_id,user_id,status);

ALTER TABLE amux.org_roles_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_roles_users_select ON amux.org_roles_users
  FOR SELECT TO authenticated USING (amux.is_org_member(org_id));
CREATE POLICY org_roles_users_write ON amux.org_roles_users
  FOR ALL TO authenticated
  USING (amux.is_org_role_manager(org_id))
  WITH CHECK (amux.is_org_role_manager(org_id));
GRANT SELECT,INSERT,UPDATE,DELETE ON amux.org_roles_users TO authenticated,service_role;
