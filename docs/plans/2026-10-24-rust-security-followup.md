# October 24 Rust security follow-up

> **For agentic workers:** Use superpowers:subagent-driven-development, systematic debugging and independent task/final reviews. User explicitly requested security remediation on 2026-10-24; the previously selected full workflow and PR update authorization continue.

**Goal:** Remove all five newly reported non-ignored findings without weakening the security gate.
**Architecture:** Targeted lockfile updates plus one manifest-only backport of official rumqttc 0.25.1. Its released parent pins the vulnerable 0.102 webpki family; an official upstream fix is not yet released. Preserve all existing runtime behavior and earlier reviewed backports.
**Tech Stack:** Rust/Cargo, rumqttc, rustls/webpki, cargo-audit, existing native regression suites.
**Spec:** User request on 2026-10-24; the security requirements of docs/plans/2026-10-20-pr1732-ci-remediation.md; preserve docs/specs/2026-10-19-app-public-code-design.md.

## Global Constraints

- Existing .github/workflows/security-audit.yml is unchanged, including its ten ignores, all-severity failure behavior and yanked checking. No new advisory ignore or filter.
- Keep ring, native roots and bundled fallback, certificate/hostname verification, MQTT TCP/WSS, Discord, updater signatures/archive formats and native speech behavior.
- Retain existing Serenity and Sherpa patches and their exact runtime source/provenance. No removal of dependencies/features to hide findings.
- Work only in the existing isolated PR worktree at baseline ebb0279d. No live database, deployment, merge to main or user-checkout dependency/cache mutation. Existing PR branch publication is authorized.
- Vendor only the exact official rumqttc 0.25.1 archive with source/checksum/license evidence. Its only upstream content change is the normalized Cargo.toml rustls-webpki dependency. No unreviewed runtime source edits or secret/protection bypasses.

## Review Focus

- Mixed native certificate stores and fallback must still reject untrusted/wrong-host certificates; use the existing actual TLS handshake tests.
- Shared patched MQTT dependency must work for desktop, daemon and transport, including actual TCP/websocket payload regressions.
- The 0.26.11 roots wrappers must resolve patched 1.x stores; a wrapper version alone is not sufficient proof.
- Path dependencies have no registry checksum in the lock; independently compare every rumqttc published file and verify only its manifest differs.
- Full locked graph must contain no vulnerable webpki/roots versions, including target-specific dependencies, and root workspace membership must exclude the vendored parent.

### Task 1: Apply and verify the complete bounded security refresh

**Files:** Cargo.toml, Cargo.lock; new vendor/rust/rumqttc-0.25.1/** plus adjacent manifest patch; vendor/rust/README.md; new docs/testing/2026-10-24-rust-security-followup.md. No first-party runtime or CI policy edits expected.
**Consumes:** Diagnosis /private/tmp/pr1732-security-20261024-diagnosis.md; actual baseline audit before.json and exact audit-command.json under /private/tmp/pr1732-security-20261024. Existing RustSec snapshot from that directory is the RED/GREEN comparison source.
**Produces:** Consistent audited graph, reproducible source patch/provenance, durable verification record and source commit.

- [ ] Read diagnosis and baseline RED evidence: full cargo-audit exits1, five vulnerabilities under the original policy. Record advisory DB commit and before-lock hash.
- [ ] Download exact official rumqttc0.25.1 archive and compare its SHA-256 with crates.io metadata. Preserve package version/features/licenses and all published files. Change only normalized dependency rustls-webpki0.102.8 ->0.103.16. Record adjacent manifest-only patch, archive/VCS hashes and removal criterion (official audited release accepts fixed webpki). Add root path patch and workspace exclusion alongside the two existing patches.
- [ ] Resolve precisely ctutils0.4.4, rustls-webpki0.103.16, webpki-root-certs1.0.10 and webpki-roots1.0.10, plus the patched parent. Remove old rustls-webpki0.102.x; preserve existing root-wrapper0.26.11 re-export behavior and all unrelated locked packages. No manual checksum/version fabrication.
- [ ] Verify all new vendored files against the official archive, with exactly one manifest deviation and every Rust file byte-identical. Inspect staged source for credential-shaped examples and prohibited artifacts before commit; do not bypass precommit/push protection. If a concrete blocker requires any source exception, report to controller before expanding scope.
- [ ] Run cargo metadata --locked; inspect inverse dependency trees and graph inventory; assert vendor package not first-party workspace member and no vulnerable versions remain.
- [ ] Run matched-snapshot full online cargo-audit with exact original ignores and yanked checks; verify before/after advisory DB revision equality and expect exit0/zero findings. Run supplemental --no-fetch advisory-only comparison and disclose its omitted yanked checks; fresh full online result remains authoritative. Preserve all remaining allowed warnings/counts explicitly.
- [ ] Run repository-wrapped desktop/gateway/transport tests (actual native Sherpa link), full daemon binary unit tests serially, exact CI formatting and desktop Clippy, and native certificate/MQTT/updater/archive regressions covered by those suites. Use CI=1, existing worktree target directories and read-only Sherpa libraries; never pnpm/bootstrap/shared-cache writes. Report conditional NATS/doc-test limits. Hosted Windows/Linux gates remain required after push; local macOS is not their pass.
- [ ] Write concise durable security follow-up record with before/after counts, exact resolved graph, source provenance and reproduction commands. Update vendor README package counts/provenance without rewriting earlier historical evidence. Self-review diff, commit only bounded product/docs files, and write ignored task report. Do not stage .superpowers artifacts.

## Review and publication

Perform task spec/quality review, then one combined final review of this security follow-up range. Existing whole-feature reviews remain historical context, not a substitute. Correct concrete findings with bounded fix/rereview. Push reviewed fix to existing PR and verify fresh security and affected CI checks; update PR evidence without adding operational details. Do not claim deployment/manual acceptance complete.
