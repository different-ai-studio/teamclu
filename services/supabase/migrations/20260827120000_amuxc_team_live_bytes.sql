-- Sum of live (non-deleted) amuxc_files.size for a team.
-- Used by FC /sync/upload/prepare byte-quota backstop (SYNC_MAX_BYTES_PER_TEAM).
-- Counts current path pointers only — not historical version blobs.

CREATE OR REPLACE FUNCTION amux.amuxc_team_live_bytes(p_team_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = amux, public
AS $$
  SELECT coalesce(sum(size), 0)::bigint
    FROM amux.amuxc_files
   WHERE team_id = p_team_id
     AND deleted = false;
$$;

COMMENT ON FUNCTION amux.amuxc_team_live_bytes(uuid) IS
  'Sum of live amuxc_files.size for the team. FC prepare quota; not disk usage.';

REVOKE ALL ON FUNCTION amux.amuxc_team_live_bytes(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION amux.amuxc_team_live_bytes(uuid) TO service_role;
