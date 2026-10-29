-- belayo recorded 20260915200000_org_roles.sql as applied, but its seed step
-- never ran there: no amux.ensure_org_system_roles(), no orgs trigger, no
-- backfill. public.roles on belayo is saas-mono's table, so none of its 79
-- orgs had a system `member` role and assignSystemOrgRole() failed with
-- "system role member missing for org" (adding staff, claiming invites).
--
-- Restates the seed function, trigger and backfill from that migration.
-- Idempotent: ON CONFLICT (org_id, code) DO NOTHING, so instances that already
-- have them (self-host) are unchanged.

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
