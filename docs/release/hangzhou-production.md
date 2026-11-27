# Hangzhou production releases

Hangzhou production uses TeamClu GitHub Actions to publish images and
`different-ai-studio/teamclu-k8s` to release them on ACK. This runbook covers
Cloud API and the existing private platform RDS database (`teamclu_platform`).
Atlas stays dormant. The Belayo Dokploy and legacy dev Compose workflows continue
to run independently. Coordinate shared changes so each environment's Cloud API
remains compatible with its database at deployment time.

## One-time enrollment

1. Review and merge the TeamClu publishing changes and the independent
   `db-migrations` Application and AppProject in `teamclu-k8s` through their PRs.
   Enroll the Application in Hangzhou Argo CD using the approved GitOps
   bootstrap. Confirm `argocd/db-migrations` targets `teamclu-prod`, renders the
   empty overlay at the reviewed Git revision, and uses manual Sync with prune
   disabled. Enrollment has no release Job.
2. Confirm the existing `cloud-api-db-migrate-psql` Secret in `teamclu-prod` has
   `PGUSER` and `PGPASSWORD` keys for `teamclu_migration_runner`. Check only
   the keys, without printing their values. Confirm private RDS connectivity,
   ACK DNS and the migration NetworkPolicy scope. Keep production connection
   settings in private GitOps and credentials in the existing Secret.
3. On initial publication, confirm the GHCR package
   `teamclu-prod-db-migrate` is Public in package settings. Have a package admin
   set visibility if needed. From Hangzhou ACK, run an image-pull smoke test
   in `atlas-accept` by digest, using the same architecture as the prod Job and
   no database credentials or registry Secret. Verify the pod's image ID and
   run `psql --version`. Use the DB Job only after the exact digest pulls.
   [GHCR package visibility](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).

## Build images

Merge source changes through the normal TeamClu CI and PR checks. The **Publish
production images** workflow observes changes between the before and after
commits of a push to `main`. Changes in `services/fc/` publish the Cloud API
image. Top-level SQL changes in `services/supabase/migrations/` or changes in
`deploy/db-migrate-psql/` publish the psql migration image. When both inputs
change, both builds use the same `main` commit. Use **Run workflow** on `main`
to publish current inputs on demand, including AI Gateway and amuxd. This
workflow builds and pushes to GHCR and has no cluster or database access.

Each matrix entry uploads `prod-release-<image-name>-<source-commit>`. Download
`image.json` and record its `image_ref` (the GHCR digest reference),
`source_commit` and `build_run`. The DB artifact also includes
`migrations.sha256`, read back from the published image and compared with the
build checkout. Treat those records as inputs to the release plan. Preserve
them and the release receipt in the private GitOps PR before Actions artifacts
expire. The build contains the current public migration SQL inventory. Review
a batch against the live ledger before deciding which files are pending.

## Plan the database release

1. Use the approved DBA route to read the current ledger from the platform RDS
   primary. Save the exact filename set privately and compare it with the SQL
   inventory. Imported historical entries can legitimately lack a matching
   current source file. Treat unexplained entries, gaps, or changes to files
   previously applied as blockers. Correct a deployed migration with a new
   file. Use the full filename as the release target since legacy timestamps
   can repeat.
2. Review the pending SQL and dependency order explicitly. Check the current
   object owners and the migration role's effective permissions, runtime
   impact, compatibility with the running Cloud API, and backup posture. Use
   SQL that can run in a PostgreSQL transaction through the psql runner. An
   operation that requires its own transaction or cannot run inside one needs
   a separately reviewed release procedure.
3. Copy the exact approved lines from the image's `migrations.sha256`, in
   filename order, into the private GitOps batch manifest. Record the verified
   database identity, the target filename and the predecessor count and digest.
   Obtain the count and digest directly from the DBA readback at the start of a
   new release:

   ```sql
   SELECT count(filename) AS ledger_count,
          md5(string_agg(filename, chr(10) ORDER BY filename COLLATE "C"))
            AS ledger_md5
   FROM _selfhost.schema_migrations;
   ```

   Save the expected final count and digest using the union of that predecessor
   filename set and the approved filenames, with the same sorting and
   newline delimiter (no trailing newline). Keep these expectations fixed for
   a retry of the same batch.
4. In `teamclu-k8s`, prepare the DB PR under
   `teamclu-service/db-migrations/prod`. Put the approved lines in
   `migrations.sha256` and record `image` (the downloaded `image.json`),
   `artifact_url`, `plan_sha256`, `target_filename`,
   `predecessor_ledger: {count, md5}`, the authorized private `rds_ipv4`,
   `mode` and `attempt` in `release.json`. Render the release and include the
   generated `release.yaml` in the prod Kustomization.

   ```sh
   prod=teamclu-service/db-migrations/prod
   python3 -B teamclu-service/db-migrations/render-release.py \
     --release "$prod/release.json" --plan "$prod/migrations.sha256" \
     > "$prod/release.yaml"
   kubectl kustomize "$prod"
   ```

   Review the digest, mounted checksums, Job name, target, runtime identity,
   deadline, Secret references and allowed private IPs in the rendered output.
   Use a dedicated preflight Job with the same release inputs as apply. Obtain
   separate reviewed Git revisions for each mode before syncing.

## Sync the database and verify the ledger

1. Schedule the approved release window. The DBA grants the dedicated login
   the scoped ability to assume `teamclu_migration_owner` and insert ledger
   filenames, with the owner grants needed for this batch. Record who will
   revoke the temporary grants and when. Confirm the live identity, private
   connection, predecessor ledger, and prior Job state. Record the observed
   TLS status alongside the approved RDS connection settings.
2. In the Hangzhou Argo CD control plane, manually Sync only
   `db-migrations` at the full, reviewed `teamclu-k8s` commit SHA, with prune
   disabled. Verify the sync result reports that SHA and the expected Job.
   Wait for preflight Job `Complete` and check the logs. Reconfirm the
   predecessor and apply the reviewed `apply` revision using the same method,
   with a distinct Job name. Only one apply Job may run at a time.

   With an authenticated Hangzhou Argo CLI and the approved SHA and Job name:

   ```sh
   argocd app sync db-migrations --revision "$GITOPS_SHA" --prune=false
   kubectl -n teamclu-prod wait --for=condition=complete "job/$JOB" --timeout=8m
   kubectl -n teamclu-prod logs "job/$JOB" -c migrate
   ```

   With ACK Workbench access, use the authorized Argo operation entry point
   for the same revision if the CLI session is unavailable. Inspect the
   Application's operation result and the Job independently.
3. Require `Complete=True` for the exact apply Job. Save the Job name, UID,
   image ID and logs. Independently read back every selected filename and the
   final count and digest on the RDS primary. Verify the expected schema
   objects and compatibility, including a read-only PostgREST check when
   affected. Argo's Sync may report success while the Job is still active.
   The release gate is Job completion **and** database readback.
4. When the Job reaches a terminal state, revoke temporary database grants and
   verify closure, including after failure or timeout. Save the receipt in
   private GitOps with the commit, image digest, Job and ledger evidence. Retain
   the completed Job until the receipt is recorded. Remove retired Jobs and
   their ConfigMaps or policies through the migration Application's scoped
   cleanup procedure after their desired manifests are retired. Before
   cleanup, check app ownership and resource names.

### Retry and rollback

A file's SQL and filename insert commit in one transaction. Earlier successful
files can remain committed if a later file fails. Read the ledger and compare
the applied prefix before opening another permission window. For a transient
failure, retain the exact digest, approved batch and predecessor values, and
Sync a new reviewed attempt after the previous Job is terminal. The runner
skips recorded files and rejects drift outside the approved prefix. Stop if
correction requires changing migration contents or acknowledging unexpected
commits. Use a new reviewed forward-fix plan. Treat a database restore as a
separate DBA incident procedure.

## Release Cloud API

After the DB receipt is verified, open a separate `teamclu-k8s` PR updating
the Cloud API digest and linking the database receipt. If there is no schema
change for the release, record the compatible deployed schema and skip the DB
PR. Job failure, unexpected ledger contents, or an affected PostgREST check
failure keeps the application release on hold.

After review and merge, render the Cloud API Argo Application at the reviewed
commit, inspect its diff and resource ownership, and manually Sync the intended
revision with prune disabled. Confirm deployment readiness, running image
digest, and the relevant API smoke checks. If necessary, use a GitOps PR to
restore the prior Cloud API digest after checking that it works with the
schema already committed.
