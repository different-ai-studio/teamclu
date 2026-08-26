-- Index for the live-bytes sum behind the per-team knowledge byte quota.
--
-- `amuxc_team_live_bytes` (and the drizzle `sumLiveBytes` on the postgres
-- backend) runs `sum(size) WHERE team_id = ? AND deleted = false` on the sync
-- WRITE path: once per prepare and once per prepare-batch call, deliberately
-- uncached so the guard cannot be fooled by a stale total.
--
-- The three existing indexes on amuxc_files are (team_id, change_seq),
-- (team_id, updated_at) and unique (team_id, path). None of them carries
-- `deleted` or `size`, so the sum heap-fetched every live row for the team —
-- up to SYNC_MAX_FILES_PER_TEAM (50k) rows per call. A single daemon tick makes
-- up to 10 prepare-batch calls, so an active team with ten devices produced
-- ~100 full aggregates per tick window: the same shape as the statement-timeout
-- cliff already hit on /v1/sessions.
--
-- Partial (live rows only) + INCLUDE (size) makes it an index-only scan, and
-- the partial predicate keeps it off the tombstone rows the sum ignores.

CREATE INDEX IF NOT EXISTS idx_amuxc_files_team_live_size
    ON amux.amuxc_files USING btree (team_id)
    INCLUDE (size)
    WHERE deleted = false;

COMMENT ON INDEX amux.idx_amuxc_files_team_live_size IS
  'Index-only scan for amuxc_team_live_bytes / sumLiveBytes (byte quota on the sync write path).';
