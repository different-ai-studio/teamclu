# Temporary Rust dependency backports

Owner: TeamClu maintainers. These two complete published crate archives are
checked in because their released parent manifests still constrain vulnerable
dependency families. Root `[patch.crates-io]` selects them; both are excluded
from the first-party workspace. They retain their original package versions,
features, runtime Rust code, build scripts, and licenses. The normalized
`Cargo.toml` dependency declarations differ, plus one credential-shaped upstream
Rustdoc example is redacted as documented below. `Cargo.toml.orig` is preserved as
published; use the adjacent `.patch` files when recreating these directories.
Do not regenerate the normalized manifests without reapplying these changes.

| Package | Official archive and SHA-256 | License |
| --- | --- | --- |
| serenity 0.12.5 | https://static.crates.io/crates/serenity/serenity-0.12.5.crate — `9bde37f42765dfdc34e2a039e0c84afbf79a3101c1941763b0beb816c2f17541` | ISC, `serenity-0.12.5/LICENSE.md` |
| sherpa-onnx-sys 1.13.7 | https://static.crates.io/crates/sherpa-onnx-sys/sherpa-onnx-sys-1.13.7.crate — `566aad07d0924a7ed897cc035cc67ad71cdfddb959717dbf445031d5d4b58d4d` | Apache-2.0, `sherpa-onnx-sys-1.13.7/LICENSE` |

The hashes match the crates.io sparse-index checksums. Verification on
2026-10-20 compared every published file: Serenity 174 files (166 Rust), Sherpa
22 files (16 Rust). 181 of 182 Rust files are byte-identical to the official
archives. The remaining file has exactly one Rustdoc literal replacement and
identical runtime code. Each package also has one changed `Cargo.toml`; there
are three changed upstream files in total. The checked-in patches record only
the two manifest changes. No local `.cargo-ok`, native libraries,
compiler outputs or probe harnesses are included.

Serenity changes `tokio-tungstenite = 0.21.0` to `0.24.0` and enables `url`,
retaining the original optional/backend feature wiring. The `url` feature is
necessary for the unchanged `Url` argument to implement `IntoClientRequest`.
This moves the Discord transport to rustls 0.23 without replacing Serenity or
changing its gateway implementation. Published VCS revision:
`1809beb0fc24f3942c500058ad4fa47e6a97d3f9`. The official stable maintenance branch
inspected during diagnosis still required 0.21; this patch is maintained here,
not represented as an upstream Serenity release.

Sherpa changes build-dependency `zip = 2` to `zip = 9`, backporting the exact
upstream fix [1a9d234ab95567eba8c2e89873a87d70b79633e2](https://github.com/k2-fsa/sherpa-onnx/commit/1a9d234ab95567eba8c2e89873a87d70b79633e2).
The product wrapper pins sys `=1.13.7`, so the wrapper, native asset version and
build script remain 1.13.7. Published VCS metadata records
`917bed95c8e5c7c18aa4d69fea42e9ef8ef0a60e` with `dirty: true`; the archive and its
checksum are canonical, not an assumed clean checkout at that revision.
The desktop builds Sherpa only on macOS. Its normal archive path is tar.bz2;
the ZIP build-script path is for iOS XCFrameworks. macOS linking does not verify
that dormant iOS extraction path.

To reproduce, download each exact archive, verify its hash, extract it under
`vendor/rust`, then apply its adjacent patch from that directory. Compare all
files against the archive and confirm only the two declared manifest deltas and
the exact Rustdoc replacement below remain.
Use Cargo to resolve the lockfile; do not edit package checksums or versions by
hand. Path packages have no registry checksum in Cargo.lock, which makes this
separate source/provenance verification necessary. Audit the complete graph,
including the patched parents and all resolved platform dependencies.

Removal criteria: replace each patch when an official audited release permits
the fixed dependency generation and passes the product's gateway/speech and
full Rust checks. Sherpa may also require updating the wrapper and native assets
together. Recheck upstreams on dependency refreshes and security advisories;
remove the matching root patch, directory and patch file together. See
`docs/testing/2026-10-20-rust-security-remediation.md` for the audit policy and
validation evidence.

## Credential-shaped documentation example redaction

GitHub push protection rejected the official upstream example at
`serenity-0.12.5/src/utils/token.rs:20`. The example is a Rustdoc assertion, not a
runtime credential. Replace only its quoted argument with
`example.not-a-token.placeholder`. The assertion still exercises the validator's
three-part format check. No function, other comment, or license byte changes.
The original value is deliberately not reproduced here or in a patch artifact.

- Official original file SHA-256: `60d0707c33a17b42dc6e55fc433b46b4b8925bc5ecb68f5a902cf1071573e165`.
- Redacted file SHA-256: `7ecd813ae9f6b83e0a4ef3568c15b6f2b7f23a645ea9f0855ac00e572d09e2de`.
- Reproduction: verify the official archive checksum, apply the adjacent manifest
  patch, locate the successful `validate` assertion on Rustdoc line 20, and
  substitute only its quoted argument with the safe example above. Verify the
  resulting file hash and compare all other bytes to the official source.

The unpublished commit containing the original example must be rewritten before
publication; deleting it only from the branch tip leaves it in outgoing history.
Do not bypass push protection or store the removed example in a redaction diff.
