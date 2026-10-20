# PR 1732 CI remediation plan

> Use superpowers:subagent-driven-development for fixes, systematic debugging
> for new failures, and independent task/final review. User authorized CI fixes
> and comparison with main on 2026-10-20.

**Goal:** Repair verified CI causes while preserving security and database gates.
**Architecture:** Separate registry infrastructure remediation from Rust dependency
remediation. Reproduce audits against one frozen advisory snapshot and compare
with main; never turn baseline vulnerabilities into silently accepted results.
**Requirements:** Current user request and the approved app-code design in
`docs/specs/2026-10-19-app-public-code-design.md` remain binding.

## Global constraints

- Keep PostgreSQL version 17.6.1.106 and the existing bootstrap, migrations,
  readiness checks and pgTAP/AI-gateway tests. No test quarantine or skipped gate.
- Preserve the existing security audit ignore list and actual severity policy.
  No new advisory ignores, target filtering, no-yanked flag or threshold weakening.
- Dependency changes must preserve TLS certificate/hostname validation, native
  roots, crypto-provider selection, MQTT/websocket, archive extraction, updater,
  speech and Discord behavior. No feature removal merely to hide dependencies.
- Work in the existing feature worktree; preserve original checkout edits. No live
  database/service changes, deployment or merge. User authorized updates to PR1732.
- Keep previous acceptance boundaries and report remaining audit findings honestly.

## Diagnosis

At head129cfc6a, all code jobs passed, including Windows desktop/daemon, Linux
 daemon, frontend and Clippy. Database job failed before SQL because all five ECR
 pulls returned Data limit exceeded. Rust audit failed with22 findings identical
 to main ba604cf9 using RustSec snapshot b19b2c83c2493961ccb12f9fc4699a00fb2c6c44.
Evidence: /tmp/teamclu-pr1732-database-diagnosis.md and
/tmp/teamclu-pr1732-security-diagnosis.md (full commands and primary references).

### Task 1: Use the official digest-pinned PostgreSQL mirror

Files: `.github/workflows/ci.yml` database job only.

- [ ] Read database diagnosis. The official Supabase mirror workflow copies the
  same version from DockerHub to ECR/GHCR. DockerHub and GHCR index/amd64 digests
  match; direct live ECR comparison was TLS-blocked and must not be overclaimed.
- [ ] Replace both database-job ECR image references with
  `ghcr.io/supabase/postgres@sha256:21ab971149317ea9cd12a8126fe4ebb34def08c8972956b0958cba0924409dab`.
  Update comment to record version17.6.1.106, official mirror provenance and why
  repeated anonymous ECR retries do not solve a data quota. Preserve retry logic
  and all startup/bootstrap/migration/test steps.
- [ ] Verify exact digest and linux/amd64 manifest metadata from diagnosis,
  inspect workflow syntax and image-reference consistency, git diff --check.
  No artificial new tests for a two-reference YAML substitution; the existing
  full database job is its meaningful end-to-end regression gate.
- [ ] Commit bounded workflow change and report root cause, checks and limits.

### Task 2: Target compatible Rust security updates and establish remaining scope

Files: Cargo.lock, plus an evidence document under docs/testing if useful.

- [ ] Read security diagnosis. Reproduce baseline with cargo-audit0.22.2, exact
  existing ignore list, same frozen1345-advisory snapshot; final runs include
  yanked checks. The existing22 findings match main exactly.
- [ ] Target quinn-proto0.11.14 to >=0.11.18 in0.11 and rustls0.23.45 to
  >=0.23.46 in0.23. Do not refresh unrelated packages. Cargo resolver may add only
  required compatible dependencies. Record precise resolved versions/diff.
- [ ] Run same-snapshot audit after changes and report removed/remaining findings
  and any new finding. Do not claim green if upstream old TLS/archive families
  remain. Compare a fresh online audit too if network allows.
- [ ] Verify cargo metadata --locked, relevant wrapper-based desktop/daemon/
  transport/gateway checks and covering TLS/network tests, no weakened policy.
  Follow TDD for any actual product behavior change; lock-only updates use audit
  RED/GREEN for removed findings plus existing compile/test gates.
- [ ] Commit compatible updates and durable comparison evidence, documenting
  exact upstream constraints and feasible reviewed migration/backport options.
  Full dependency migrations or temporary security exceptions need a concrete
  reviewed scope; do not improvise dependency removals or local patched sources
  under the guise of a lock-only update. Controller handles that next decision.

## Review and publication

Review each task's diff/evidence independently, then final combined diff. Fix
verified findings within scope. Push reviewed commits to the existing PR and
observe fresh CI. A remaining baseline audit blocker must be surfaced for the
next concrete remediation decision, not hidden or called fixed. Database image
transport success alone is not pgTAP success. Preserve logs in this plan's ignored
workspace; commit only durable evidence and source changes.
