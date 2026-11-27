# Hangzhou platform database migrations

The ACK Job applies reviewed incremental SQL to the existing platform RDS and
records it in `_selfhost.schema_migrations`. See the
[Hangzhou release runbook](../../docs/release/hangzhou-production.md) for
production release selection, approval, verification, and retry.

The [production publishing workflow](../../.github/workflows/prod-images.yml)
uses `sh stage-image.sh NEW_DIRECTORY` to stage the Dockerfile, runner, and
canonical top-level public SQL in a dedicated build context. It publishes a
digest and the image's SHA-256 inventory. The release ConfigMap mounts the
reviewed subset at `/release/migrations.sha256`. The image accepts `preflight`
and `apply`, and verifies the subset against the image before connecting.
Set `MIGRATION_PLAN_FILE` to use a different mount path.

Set `EXPECTED_DB_HOST`, `EXPECTED_DB_NAME`, and `EXPECTED_DB_USER` to reviewed
target values. Set `EXPECTED_LEDGER_COUNT` and `EXPECTED_LEDGER_MD5` from the
reviewed predecessor ledger. Preflight verifies the identity, predecessor
ledger, and the login's ability to insert ledger filenames and switch to
`MIGRATION_DB_ROLE`. Use the same immutable batch when switching to `apply`.

Each file runs as the DDL role inside a transaction. The runner switches back
to the login to insert the ledger row before committing. A retry accepts only
a contiguous applied prefix of the approved batch. Commands that manage
their own transactions or require execution outside a transaction need a
separately reviewed procedure. The runner sends a PostgREST schema reload
notification after applying the batch.

Run `sh deploy/db-migrate-psql/tests/bundle.sh` for bundle selection checks.
Run `bash deploy/db-migrate-psql/tests/integration.sh` with PostgreSQL 17 on
`PATH` for the transaction, failure recovery, and target checks.
