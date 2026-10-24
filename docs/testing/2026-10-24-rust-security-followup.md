# Rust security follow-up (2026-10-24)

The unchanged `security-audit.yml` policy reported five non-ignored findings in
`Cargo.lock` before this refresh: ctutils 0.4.3, rustls-webpki 0.102.8 and
0.103.15, webpki-root-certs 1.0.7, and webpki-roots 1.0.7. The baseline lockfile
SHA-256 was `4e5b0c2939fd7f8c81d26625fb9481890ec8bdaa1b4eac249dff8ad1c9935f4d`.
The resolved lockfile SHA-256 is
`00282f64bc44844b78239739c82717d048ad72b7aa1e265d0b37096dfb308251`.

| Package | Before | After | Resolution |
| --- | --- | --- | --- |
| ctutils | 0.4.3 | 0.4.4 | `digest 0.11.3` accepts the patch. |
| rustls-webpki | 0.102.8 and 0.103.15 | 0.103.16 only | The rumqttc manifest backport removes its 0.102 constraint; the other TLS parents accept 0.103.16. |
| webpki-root-certs | 1.0.7 | 1.0.10 | Locked optional `ureq 3.3.0` dependency; no active macOS Cargo-tree path. |
| webpki-roots | 1.0.7 | 1.0.10 | Existing `webpki-roots 0.26.11` wrapper still re-exports the fixed 1.x list. |
| rumqttc | 0.25.1 registry | 0.25.1 path patch | Same published version/features and Rust source. |

Cargo generated the lockfile. `cargo metadata --locked --format-version 1` resolved
1,154 packages and 11 first-party workspace members; the vendored rumqttc path
is a patched dependency, not a workspace member. Inverse trees show rumqttc
under desktop, daemon and teamclu-transport; rustls-webpki 0.103.16 also serves
rustls 0.23 and async-nats. The unchanged webpki-roots 0.26.11 wrapper points to
1.0.10. Only these package names change version or source, including the
rumqttc source switch; dependent package lists update accordingly. The older
rustls-webpki 0.102.8 entry is removed.

## Provenance and maintenance

`vendor/rust/rumqttc-0.25.1` is the complete official
[0.25.1 crate archive](https://static.crates.io/crates/rumqttc/rumqttc-0.25.1.crate),
whose SHA-256 `0feff8d882bff0b2fddaf99355a10336d43dd3ed44204f85ece28cf9626ab519`
matches the crates.io sparse-index checksum. Published VCS metadata names
`f1e9e8d558783f942993046679cdf3c8c3a3d36b`. All 73 archive files were
compared byte for byte: 65 Rust files and every other published file are
identical except normalized `Cargo.toml`. That single manifest changes only
`rustls-webpki = "0.102.8"` to `"0.103.16"`; the adjacent `.patch` records it.
The original manifest SHA-256 is
`537a03168b2328ad87423bba12a9b83638b17859d3cad2cf76cad8c5474888f5`,
and the patched SHA-256 is
`a8407b6a2d35021f7da60314bad331d34791c301e6d9aa47469571101b58bad7`.
The package remains Apache-2.0. Remove this root patch, vendor directory, and
adjacent patch together when an official audited rumqttc release accepts fixed
webpki and passes the product's MQTT/TLS regressions. The prior Serenity and
Sherpa vendor evidence remains in `vendor/rust/README.md` and
[the October 20 record](2026-10-20-rust-security-remediation.md).

## Audit evidence

The original and final **full online** cargo-audit runs used the same ten
existing ignores, all-severity behavior, yanked checks, and advisory database
revision `21d909e4c8bd4e14c7aea58bf980c881a0053ab1` (1,352 advisories).
The original run exited 1 with five findings. The final run exited 0 with zero
findings. Both retained 32 allowed warnings: one notice, 18 unmaintained,
nine unsound, and four yanked. No ignore or CI policy changed. A supplemental
`--no-fetch` run against the frozen database also found zero advisories; that
mode omitted yanked checks and is not the authoritative policy result. The
full online run is the matched-snapshot comparison and yanked check.

The raw comparison is saved locally at
`/private/tmp/pr1732-security-20261024/before.json` and
`/private/tmp/pr1732-security-20261024-after-online.json`; the supplemental
output is `/private/tmp/pr1732-security-20261024-after-frozen.json`. For a new
run, use the cargo-audit command and ten `--ignore` arguments in
`.github/workflows/security-audit.yml` without weakening its defaults.

## Local verification

All commands used Rust 1.97.1, `CI=1`, `BUILD_ENV=dev`, the worktree's own
`.cargo-target`, an isolated Cargo registry cache, and the read-only Sherpa
1.13.7 native library directory. Desktop, gateway, and transport Cargo commands
used `scripts/rust-cli.js`; the daemon used `scripts/daemon-cargo.js` with its
separate sidecar target. No first-party runtime source changed.

| Check | Result |
| --- | --- |
| teamclu-transport full tests | 19 unit tests passed. Two NATS integration harness cases returned early because `AMUXD_NATS_TEST_URL` was unset; one documentation example is intentionally ignored. TLS trust, wrong-host, native-root, bundled-fallback, TCP/WSS selection covered. |
| teamclu-gateway full tests | 221 unit and 1 Discord WebSocket integration test passed. |
| Desktop all test targets compile, then `--lib` | Compile passed; 469 unit tests passed, including certificate and hostname rejection, updater and archive cases. The team-share integration smoke target is compile-only because it requires a Cloud API endpoint. |
| Daemon `--bin amuxd -- --test-threads=1` | 1,941 passed, none failed; includes MQTT TCP/WSS and archive behavior. |
| CI desktop and introspect formatting | Both checks passed. |
| Desktop Clippy `--all-targets -- -D warnings` | Passed. Existing third-party Serenity deprecation and future-incompatibility warnings remain. |

The NATS roundtrip tests require an external `nats-server` and were not
exercised here. The ignored transport documentation example did not execute. Native macOS linking was exercised; hosted Windows/Linux CI gates
remain required after publication. This record does not claim deployment or
manual acceptance.
