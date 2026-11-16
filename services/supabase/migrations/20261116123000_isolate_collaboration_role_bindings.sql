-- Stop the Cloud API, apply this migration, then start the compatible API.
-- Hosted Betly uses its guarded registered migration of the same timestamp.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

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
  deleted_at timestamptz,
  UNIQUE NULLS NOT DISTINCT (user_id,role_id,store_id)
);
COMMENT ON TABLE amux.org_roles_users IS
  'TeamClu collaboration grants only. Never grants Betly employee or organization-node permissions.';
CREATE INDEX ON amux.org_roles_users(org_id,user_id,status);
COMMENT ON COLUMN amux.org_roles_users.id IS 'Collaboration grant identifier';
COMMENT ON COLUMN amux.org_roles_users.user_id IS 'Authenticated TeamClu identity';
COMMENT ON COLUMN amux.org_roles_users.role_id IS 'Shared role catalog identifier; retains document ACL identity';
COMMENT ON COLUMN amux.org_roles_users.org_id IS 'Organization owning this collaboration grant';
COMMENT ON COLUMN amux.org_roles_users.store_id IS 'Legacy document ACL distinction only; never an employee node';
COMMENT ON COLUMN amux.org_roles_users.status IS 'Whether the collaboration grant is active';
COMMENT ON COLUMN amux.org_roles_users.is_primary IS 'Primary role preference retained from the source grant';
COMMENT ON COLUMN amux.org_roles_users.expires_at IS 'Optional collaboration grant expiration';
COMMENT ON COLUMN amux.org_roles_users.created_at IS 'Grant creation timestamp';
COMMENT ON COLUMN amux.org_roles_users.updated_at IS 'Last grant update timestamp';
COMMENT ON COLUMN amux.org_roles_users.created_by IS 'Identity that created the grant';
COMMENT ON COLUMN amux.org_roles_users.updated_by IS 'Identity that last updated the grant';
COMMENT ON COLUMN amux.org_roles_users.updated_note IS 'Audit note for the grant update';
COMMENT ON COLUMN amux.org_roles_users.deleted_at IS 'Nullable deletion timestamp required by the common audit schema';


-- Serialize the one-time snapshot against legacy writers. The Cloud API must
-- remain stopped until its compatible version has been started.
LOCK TABLE public.roles_users IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO amux.org_roles_users
  (id,user_id,role_id,org_id,store_id,status,is_primary,expires_at,created_at,updated_at,created_by,updated_by,updated_note)
SELECT DISTINCT ON (ru.user_id,ru.role_id,ru.store_id)
  ru.id,ru.user_id,ru.role_id,ru.org_id,ru.store_id,ru.status,ru.is_primary,
  ru.expires_at,ru.created_at,ru.updated_at,ru.created_by,ru.updated_by,ru.updated_note
FROM public.roles_users ru
WHERE EXISTS (
  SELECT 1 FROM amux.teams t JOIN amux.actors a ON a.team_id=t.id
  WHERE t.oid=ru.org_id AND a.user_id=ru.user_id
) OR EXISTS (
  SELECT 1 FROM amux.support_identities si
  WHERE si.org_id=ru.org_id AND si.user_id=ru.user_id
)
ORDER BY ru.user_id,ru.role_id,ru.store_id,(ru.status='active') DESC,
  ru.expires_at DESC NULLS FIRST,ru.created_at,ru.id;

-- Repoint existing helpers without replacing their environment-specific auth,
-- member-floor or support-identity logic. Owners and EXECUTE ACLs are retained.
DO $bindings$
DECLARE
  signature text;
  target regprocedure;
  definition text;
  original_owner oid;
  original_acl aclitem[];
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'amux.current_team_role(uuid)',
    'amux.has_org_role_code(uuid,text)',
    'amux.is_org_role_manager(uuid)',
    'amux.ensure_support_identity(uuid)',
    'amux.backfill_roles_users_from_team_members()'
  ] LOOP
    target := to_regprocedure(signature);
    IF target IS NULL AND signature='amux.backfill_roles_users_from_team_members()' THEN
      CONTINUE;
    END IF;
    IF target IS NULL THEN RAISE EXCEPTION 'Missing collaboration helper %',signature; END IF;
    SELECT pg_get_functiondef(oid),proowner,proacl INTO definition,original_owner,original_acl
      FROM pg_proc WHERE oid=target;
    IF position('public.roles_users' IN definition)=0 THEN
      RAISE EXCEPTION 'Unaudited collaboration helper %',signature;
    END IF;
    EXECUTE replace(definition,'public.roles_users','amux.org_roles_users');
    IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=target
      AND (proowner IS DISTINCT FROM original_owner OR proacl IS DISTINCT FROM original_acl)) THEN
      RAISE EXCEPTION 'Collaboration helper owner or grants changed';
    END IF;
  END LOOP;
END $bindings$;

-- Agents keep the inviter's collaboration grants separately from the explicit
-- employee-node grants copied by the existing claim body. As before, rotation
-- only adds effective grants; it does not revoke an already granted role.
DO $agent_bindings$
DECLARE
  target regprocedure := 'amux.claim_team_invite_legacy(text)'::regprocedure;
  definition text := pg_get_functiondef(target);
  anchor text := '    insert into amux.agent_member_access ';
  addition text := $copy$
    if v_team_org is not null then
      insert into amux.org_roles_users
        (user_id,role_id,org_id,store_id,status,is_primary,expires_at)
      select v_user_id,ru.role_id,ru.org_id,ru.store_id,'active',ru.is_primary,ru.expires_at
        from amux.actors inviter
        join amux.org_roles_users ru on ru.user_id=inviter.user_id
       where inviter.id=v_invite.invited_by_actor_id
         and ru.org_id=v_team_org and ru.status='active'
         and (ru.expires_at is null or ru.expires_at>now())
      on conflict (user_id,role_id,store_id) do nothing;
    end if;

$copy$;
  original_owner oid;
  original_acl aclitem[];
BEGIN
  -- The audited legacy test deployment has never inherited employee roles.
  -- Keep its different invitation contract unchanged.
  IF position('public.roles_users' IN definition)>0 THEN
    IF position(anchor IN definition)=0 OR position('v_team_org' IN definition)=0 THEN
      RAISE EXCEPTION 'Unaudited agent collaboration inheritance body';
    END IF;
    SELECT proowner,proacl INTO original_owner,original_acl FROM pg_proc WHERE oid=target;
    EXECUTE replace(definition,anchor,addition || anchor);
    IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=target
      AND (proowner IS DISTINCT FROM original_owner OR proacl IS DISTINCT FROM original_acl)) THEN
      RAISE EXCEPTION 'Agent helper owner or grants changed';
    END IF;
  END IF;
END $agent_bindings$;

ALTER TABLE amux.org_roles_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_roles_users_select ON amux.org_roles_users
  FOR SELECT TO authenticated USING (amux.is_org_member(org_id));
CREATE POLICY org_roles_users_write ON amux.org_roles_users
  FOR ALL TO authenticated
  USING (amux.is_org_role_manager(org_id))
  WITH CHECK (amux.is_org_role_manager(org_id));
GRANT SELECT,INSERT,UPDATE,DELETE ON amux.org_roles_users TO authenticated,service_role;

COMMIT;
