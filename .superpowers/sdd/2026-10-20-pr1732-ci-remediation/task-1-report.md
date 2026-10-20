# Task 1 report: digest-pinned Supabase PostgreSQL image

## Change

Updated only the database job in `.github/workflows/ci.yml`: both image references now use `ghcr.io/supabase/postgres@sha256:21ab971149317ea9cd12a8126fe4ebb34def08c8972956b0958cba0924409dab`. The adjacent comment records Supabase's official GHCR mirror, PostgreSQL 17.6.1.106, the Docker Hub/index and linux/amd64 digest verification, and why retrying anonymous ECR pulls does not restore a shared data quota.

The existing five-attempt pull retry and all container startup/readiness, bootstrap, migration, pgTAP, and AI-gateway test steps were preserved.

## Root cause

The supplied failing job log shows five ECR pulls ending in `toomanyrequests: Data limit exceeded`, before container startup or SQL. Repeating anonymous pulls against the same shared egress quota cannot cure a depleted data allowance. This run therefore provides no migration or pgTAP result.

## Checks

- Exact image reference check: passed; the pinned GHCR reference appears exactly twice in the database job and no ECR image reference remains there.
- Existing database-flow anchors (retry, startup/readiness, bootstrap, migrations, pgTAP suite): present.
- Ruby YAML parser: `workflow YAML syntax: valid`.
- `git diff --check`: passed with no output.
- Scope: diff is limited to `.github/workflows/ci.yml`, with the two references and explanatory comment only.

The diagnosis records the GHCR/Docker Hub OCI index digest as `sha256:21ab971149317ea9cd12a8126fe4ebb34def08c8972956b0958cba0924409dab` and the linux/amd64 child digest as `sha256:5e52ca81790ae3aa1c2f8c20df41dd96404c8ab29632dddf113b881de785ee92`.

## Limits

The diagnosis established that Supabase's official mirror workflow copies the version from Docker Hub to both ECR and GHCR, and observed identical Docker Hub and GHCR index/platform digests. Direct live ECR manifest comparison was blocked by a TLS handshake failure. The patch therefore relies on official mirror provenance and the observed GHCR/Docker Hub digest match; it does not claim an independent live ECR digest check. The actual remote pull, container startup, migrations, and tests require a fresh GitHub Actions database job.
