-- Drop the two OSS-sync cleanup functions.
--
-- They came from 20260527000002_oss_sync_cleanup.sql, which also created the
-- pg_cron extension and scheduled them. FC later reimplemented both as HTTP
-- cron tasks, because a plpgsql function can reach the registry but not the
-- object store — "garbage collection" that deletes the amuxc_blobs row and
-- leaves the bytes behind is not collection, it is forgetting where the
-- garbage is.
--
-- What actually happened after that: the FC tasks rode an opt-in compose
-- profile nobody enabled, and pg_cron was never installed on the deployment
-- either (`select extname from pg_extension where extname='pg_cron'` returns
-- nothing; `cron.job` does not exist). So neither copy has ever run here. The
-- functions have sat in `amux` since the baseline with nothing calling them.
--
-- The FC tasks are removed in the same change as this migration. Upload
-- sessions and orphan blobs now accumulate without bound — that is a known,
-- accepted consequence, not an oversight. Whatever collects them next wants
-- the object store in scope, so it will not be these.
--
-- Idempotent: the archived pre-baseline migration created them under `app.`,
-- the baseline under `amux.`, and a deployment may carry either.

drop function if exists amux.oss_sync_abandon_expired_sessions();
drop function if exists amux.oss_sync_gc_orphan_blobs();
drop function if exists app.oss_sync_abandon_expired_sessions();
drop function if exists app.oss_sync_gc_orphan_blobs();
