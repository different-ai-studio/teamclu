-- Where this app's data physically lives.
--
-- finalizeDeploy used to derive the org fresh every time, via
-- resolveTeamOrgId(team_id). But that function answers "which org does this
-- team belong to RIGHT NOW", and what a deploy needs is "which database was
-- this app's schema created in". The two diverge:
--
--   * reject_team_reassignment guards rows moving between teams; nothing
--     guards `teams.oid` itself, and FC has no code path that writes it — so
--     an ops correction is enough to change it.
--   * `teams.oid` is nullable by design (the first team is created without an
--     org), i.e. it is a back-filled field to begin with.
--
-- Once oid changes, re-deriving is actively destructive: ensureOrgDatabaseExists
-- happily creates the NEW database, the provisioner builds a fresh empty schema
-- there, and the app goes live with an empty database while its real data sits
-- in the old one. The data browser hits the same fork and reports "no tables",
-- which is indistinguishable from the legitimate "deployed but never visited"
-- state.
--
-- So this column is not a cache: it is the record of a decision made once, and
-- every later deploy follows it.
--
-- Deliberately NOT a foreign key. It records where data went — closer to a log
-- entry than to a live tenant pointer — and `on delete set null` would erase
-- the only pointer to that data at exactly the moment someone deletes the org.
--
-- Deliberately NOT backfilled: rows that predate the column have no trustworthy
-- answer, and inventing one from today's `teams.oid` would just launder a guess
-- into a fact. NULL means "derive it, and say so in the log".

alter table amux.apps
  add column if not exists org_id uuid;

comment on column amux.apps.org_id is
  'Org database (tc_org_<hex>) this app''s schema was created in. Written on the first successful finalize and never re-derived after that. Not a foreign key: it is a historical fact, not a live tenant pointer.';
