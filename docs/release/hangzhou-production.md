# Hangzhou production releases

Hangzhou production uses TeamClu GitHub Actions to publish images and
`different-ai-studio/teamclu-k8s` to release them on ACK. This runbook covers
Cloud API and the existing private platform RDS database (`teamclu_platform`).
Atlas stays dormant. The Belayo Dokploy and legacy dev Compose workflows continue
to run independently. Coordinate shared changes so each environment's Cloud API
remains compatible with its database at deployment time.

## Release from GitHub

1. Merge the reviewed source PR in [TeamClu](https://github.com/different-ai-studio/teamclu)
   and download the successful production image artifacts.
2. If the release has pending database migrations, coordinate the ledger and
   schema checks with the DBA. In [teamclu-k8s](https://github.com/different-ai-studio/teamclu-k8s),
   merge the reviewed preflight and apply PRs separately. Wait for each Job's
   GitHub result before proceeding.
3. Merge the reviewed Cloud API image PR in `teamclu-k8s`. With auto-sync on,
   wait for the workflow to report `Synced` and `Healthy`, then run the
   relevant API smoke checks.

Release operators perform these steps in GitHub. The DBA supplies database
verification. Platform operators handle one-time enrollment and troubleshoot
cluster access when needed.

## One-time enrollment for platform operators

1. Review and merge the TeamClu publishing changes and the independent
   `db-migrations` Application in `teamclu-k8s` through their PRs. Enroll the
   Application in Hangzhou Argo CD using the approved GitOps bootstrap.
   Confirm `argocd/db-migrations` uses the existing workload AppProject,
   targets `teamclu-prod`, and renders the empty overlay at the reviewed Git
   revision. Auto Sync is enabled and prune is disabled. Enrollment has no
   release Job.
2. Provision the dedicated `db-migrate-platform-admin` Secret in
   `teamclu-prod` through the approved credential handoff. It supplies
   `PGUSER` and `PGPASSWORD` for the standing `teamclu_platform_admin`
   migration identity. Check Secret keys without printing their values.
   Confirm private RDS connectivity, ACK DNS and the migration NetworkPolicy.
   Limit use of this Secret to the migration Job. The account has broad
   platform database privileges, so treat workloads that can mount it
   as able to use those privileges. Keep production connection settings in
   private GitOps and credentials in the Secret. Repeat the Job preflight
   after credential rotation.
3. Confirm the Hangzhou ACR Personal repository
   `teamclu/teamclu-prod-db-migrate` is public. From Hangzhou ACK, run an
   image-pull smoke test in `atlas-accept` by digest using the ACR VPC
   hostname, the prod Job architecture, and no database or registry
   credentials. Verify the pod's image ID and run `psql --version`.
   Use the DB Job only after the exact digest pulls.
4. Configure the [Argo CD Actions integration](https://github.com/different-ai-studio/teamclu-k8s/blob/main/docs/production-argocd-actions.md).
   GitHub-hosted runners use the scoped Argo CD credentials in repository
   Actions Secrets. Release operators do not need to copy the credentials.

## Build images

Merge source changes through the normal TeamClu CI and PR checks. The **Publish
production images** workflow observes changes between the before and after
commits of a push to `main`. Changes in `services/fc/` publish the Cloud API
image. Top-level SQL changes in `services/supabase/migrations/` or changes in
`deploy/db-migrate-psql/` publish the psql migration image. When both inputs
change, both builds use the same `main` commit. Use **Run workflow** on `main`
to publish current inputs on demand, including AI Gateway and amuxd. This
workflow publishes to `registry.cn-hangzhou.aliyuncs.com/teamclu` using
the existing GitHub Actions ACR credentials. It has no cluster or database access.

Each matrix entry uploads `prod-release-<image-name>-<source-commit>`. Download
`image.json` and record its `image_ref` (the ACR VPC digest reference),
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
   object owners and the platform administrator's effective permissions, runtime
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
   Use a dedicated preflight Job with the same release inputs as apply. Prepare
   separate reviewed GitOps PRs for preflight and apply, in that order. Leave
   each PR unmerged until its execution window is open.

## Merge the database release and verify the ledger

1. Schedule the approved release window. Confirm the Job expects
   `teamclu_platform_admin`, its private connection targets the platform
   primary, and the predecessor ledger and prior Job state match the plan.
   Preflight verifies the login, selected role and ledger insert permission.
   The standing account uses its existing privileges for each approved
   release. Record the observed TLS status alongside the approved
   RDS connection settings.
2. Merge the preflight PR during the approved window. Argo CD automatically
   reconciles `db-migrations` from GitOps `main`. Open the
   [Observe Hangzhou Argo CD releases workflow](https://github.com/different-ai-studio/teamclu-k8s/actions/workflows/watch-production-argocd.yml)
   run for the **GitOps merge SHA**. Check the `db-migrations` job summary
   for the expected preflight Job and `Complete`, then reconfirm the
   predecessor with the DBA.
3. Merge the reviewed apply PR during the approved window, with the same
   inputs and a distinct Job name. The merge releases production SQL. Keep
   one database release in flight at a time and avoid auto-merge on migration
   PRs. In the workflow run for the apply merge, require `Complete` for the
   exact apply Job. Record the merge SHA, observed revision, Job name and UID,
   image digest, and the GitHub run link. The workflow can accept a later
   `main` revision when it renders the same desired resources. An Argo CD
   sync can succeed while the migration Job is still running. Retained
   historical resources can also leave the DB Application `OutOfSync`
   after the current Job completes.
4. When the Job reaches a terminal state, confirm the migration connection
   closed. Have the DBA independently verify each selected filename and the
   final ledger count and digest on the RDS primary, the expected schema, and
   a read-only PostgREST check when affected. Save that evidence alongside the
   GitHub Job result in the private GitOps receipt. Retain
   the completed Job until the receipt is recorded. Remove retired Jobs and
   their ConfigMaps or policies through the migration Application's scoped
   cleanup procedure after their desired manifests are retired. Before
   cleanup, check app ownership and resource names.

### Recheck a Job in GitHub

On the workflow page, select **Run workflow** on `main`. Set `app` to
`db-migrations`, `revision` to the full preflight or apply GitOps merge
SHA, and `action` to `observe`. This reads the Job state without running
the migration again. The summary reports the exact Job and its terminal
result. Job logs are available to platform operators for troubleshooting.

For `Failed`, a timeout, or an authorization or revision error, hold the
release. A timeout leaves the Job outcome unknown. Have the platform owner
check the current Job and have the DBA confirm its connection and ledger
state before any retry.

### Retry and rollback

A file's SQL and filename insert commit in one transaction. Earlier successful
files can remain committed if a later file fails. Read the ledger and compare
the applied prefix before approving another attempt. For a transient
failure, retain the exact digest, approved batch and predecessor values, and
merge a new reviewed attempt after the previous Job is terminal. The runner
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

After review and merge, find the `cloud-api` job in the same GitHub workflow
for that GitOps merge SHA. With auto-sync enabled, wait for `Synced` and
`Healthy` at the reviewed revision or an equivalent descendant. Confirm
deployment readiness, the running image digest, and the relevant API smoke
checks. Use **Run workflow** with `app=cloud-api`, the full GitOps merge SHA,
and `action=observe` to check again.

Use **manual Sync** only for an approved Cloud API release when auto-sync is
disabled and there is no operation in flight. If auto-sync is off for a
release freeze, honor the freeze until it is lifted. In GitHub select
**Run workflow** on `main`, set `app=cloud-api`, enter the full GitOps
merge SHA as `revision`, and set `action=sync`. The dispatch requires
`TEAMCLU_ENABLE_CLOUD_API_MANUAL_SYNC=true` and the scoped sync credential.
It verifies Argo CD has
compared the reviewed release and that `main` still renders it, then syncs
the configured Git target with prune off. If a manual dispatch times out,
use `observe` and confirm the current operation before dispatching again.
For `db-migrations` with auto-sync disabled, hold the release and coordinate
with the DBA and platform owner.

Use a reviewed GitOps PR to restore the prior Cloud API digest if needed.
First check that the prior version works with the schema already committed.
