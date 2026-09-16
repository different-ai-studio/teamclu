-- current_team_role must never answer NULL for an actual team member.
--
-- Every authorization site in this schema spells the check the same way:
--
--   if amux.current_team_role(v_team_id) not in ('owner', 'admin') then
--     raise exception '...' using errcode = '42501';
--   end if;
--
-- In SQL `NULL not in ('owner','admin')` is NULL, and `if NULL then` takes the
-- ELSE branch. So a NULL role does not deny — it ADMITS, silently, at all 26
-- of those call sites (remove_team_actor, set_team_default_agent, the agent
-- delete authz RPC, and every RLS policy behind is_team_admin_or_owner).
--
-- Before 20260915200000 that was unreachable: amux.team_members.role was NOT
-- NULL, so a member always had one. Reading the role from roles_users made NULL
-- the ordinary answer for anyone the backfill did not reach, or who joined
-- through a path that has not written a binding yet — and every one of those
-- people silently became an owner as far as the guards were concerned.
-- services/supabase/tests/025_agent_delete_authz.sql is what catches it: a
-- plain member could delete a team-visible agent.
--
-- The floor is MEMBERSHIP, not the legacy column. Holding an actor in the team
-- makes you at least a `member`; that is the least privilege the guards can act
-- on, and it restores the invariant every call site already assumed. An org
-- role, when there is one, still wins.

CREATE OR REPLACE FUNCTION amux.current_team_role(target_team_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'auth', 'amux'
AS $$
  SELECT COALESCE(
    (
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
      LIMIT 1
    ),
    (
      -- Team-scoped, like 20260813140000: current_member_id() returns the
      -- oldest actor across ALL teams, which is the wrong one for a
      -- multi-team user.
      SELECT 'member'
      FROM amux.team_members tm
      WHERE tm.team_id = target_team_id
        AND tm.member_id = amux.current_actor_id_for_team(target_team_id)
      LIMIT 1
    )
  );
$$;

REVOKE ALL ON FUNCTION amux.current_team_role(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION amux.current_team_role(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION amux.current_team_role(uuid) TO service_role;
