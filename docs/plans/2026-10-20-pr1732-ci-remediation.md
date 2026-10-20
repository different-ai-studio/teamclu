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

### Task 2: Remove all non-ignored Rust audit findings without weakening gates

Files: Cargo.toml/Cargo.lock; daemon/desktop/transport Cargo.toml and minimal
TLS API call sites; desktop plugin registration/capability and updater wiring
tests; official-source patched parents under `vendor/`; durable security evidence
under docs/testing. Avoid unrelated source or dependency refreshes.

- [ ] Read the updated security diagnosis and temporary probe evidence in
  /tmp/teamclu-pr1732-security-diagnosis.md and /tmp/teamclu-pr1732-audit.
  Baseline22 findings exactly match main using the same frozen advisory database
  and original ignore list; record this RED evidence before fixes.
- [ ] Target quinn-proto0.11.14 -> >=0.11.18 in0.11 and rustls0.23.45 ->
  >=0.23.46 in0.23. Upgrade daemon zip5 and desktop zip8 to fixed zip>=9.0.0
  (9.0.5 observed), preserving requested compression features.
- [ ] Move rumqttc0.24 ->0.25.1 consistently in daemon/desktop/transport, direct
  rustls0.22 ->0.23.46+ in daemon/transport, daemon tokio-rustls0.25 ->0.26.
  Reconcile native-root loader API only as necessary. Preserve certificate and
  hostname verification, native-root behavior and explicit crypto-provider
  selection; keep MQTT TCP and websocket semantics.
- [ ] Verify obsolete tauri-plugin-updater is unused beyond registration,
  capability, dependency and two static assertions in tests/e2e/auto-update.test.ts.
  If confirmed, remove that unused plugin/dependency/capability and change those
  assertions to pin the real custom updater wiring. Preserve custom updater
  download/minisign checks, Windows MZ installer handling, configured public key,
  endpoints and createUpdaterArtifacts metadata. No auto-update feature removal.
- [ ] Backport official Sherpa fix1a9d234ab95567eba8c2e89873a87d70b79633e2:
  vendor official crates.io sherpa-onnx-sys1.13.7 with licenses/provenance, change
  only its build-dependency zip2 ->9. Keep original build.rs/native artifact version.
  Official current1.13.8 release predates the fix. Temporary DOCS_RS compile probe
  passed the unchanged build.rs against zip9; actual macOS wrapper build remains
  required, and that probe does not validate iOS binary extraction.
- [ ] Vendor official crates.io serenity0.12.5 with licenses/provenance; change
  only tokio-tungstenite0.21 ->0.24 with features=["url"], retaining original
  transport features. Temporary compile probe passed without Rust source edits;
  omission of url fails IntoClientRequest and is not a valid patch. Root
  [patch.crates-io] entries select these two reproducible, reviewed parent patches.
  Verify vendor Rust sources byte-for-byte against official package archives;
  document package hashes, manifest diffs and removal criteria. Do not silently
  use arbitrary forks or pretend local-source findings disappeared.
- [ ] Resolve lock consistently with targeted versions. Run cargo metadata
  --locked and same-snapshot full audit with yanked checks and exact ignorelist;
  expected zero non-ignored vulnerabilities, then fresh online audit too. Any
  remaining/new finding is a real failure, not a waiver.
- [ ] For necessary API/product changes follow TDD/regression tests first. Run
  covering native TLS/MQTT/archive/updater/Discord checks, relevant full Rust
  suites/builds through repo wrappers, formatting/clippy, updater wiring tests,
  and license/source consistency checks. Use existing read-only Sherpa libs and
  task-local target/caches, never mutable original-checkout output. Windows/Linux
  CI must validate target-specific paths after push; local host is not their pass.
- [ ] Self-review, commit and report exact commands/results plus before/after
  comparison, new dependency inventory and any limits. Do not add ignored process
  reports to Git: .superpowers artifacts stay local, NEVER git add -f them.

## Review and publication

Review each task's diff/evidence independently, then final combined diff. Fix
verified findings within scope. Push reviewed commits to the existing PR and
observe fresh CI. A remaining baseline audit blocker must be surfaced for the
next concrete remediation decision, not hidden or called fixed. Database image
transport success alone is not pgTAP success. Preserve logs in this plan's ignored
workspace; commit only durable evidence and source changes.
