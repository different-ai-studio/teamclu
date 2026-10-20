# Rust dependency security remediation — 2026-10-20

The original PR and main each had the same 22 non-ignored cargo-audit matches.
The resolved workspace graph now has zero, with the original command policy
and all ten ignores preserved. No workflow or feature was removed to hide an
audit finding. The obsolete registered Tauri updater plugin was unused: the
product already downloads, verifies and installs updates through its custom
commands. Those commands, endpoint/public-key configuration and updater-artifact
release metadata remain intact.

## Audit reproduction and results

Tool: cargo-audit 0.22.2. Frozen RustSec database:
`b19b2c83c2493961ccb12f9fc4699a00fb2c6c44` (1345 advisories).
Original main: `ba604cf9dda7a8f39bd59d576daca19ab91587be`; implementation base:
`778c75c0246c6e825cfc4dd93129a37f8390e7d9`.
A fresh online database fetch on 2026-10-20 resolved the same RustSec commit.

| Run | Exit | Non-ignored vulnerabilities | Allowed warnings |
| --- | --- | --- | --- |
| PR before migration, frozen DB | 1 | 22 | 30 |
| main baseline, same DB | 1 | 22 | 30 |
| Final graph, frozen DB | 0 | 0 | 30 |
| Final graph, fresh online DB | 0 | 0 | 30 |

The 30 warnings remain 1 notice, 18 unmaintained, 8 unsound and 3 yanked. They
are permitted by the existing gate, not silently eliminated. The workflow
comment mentions high/critical, but its actual Rust command has no severity
threshold: all non-ignored vulnerabilities fail. That actual policy is preserved.

Run from the root with the project's locked graph:

```sh
cargo audit --db /path/to/frozen/advisory-db --no-fetch --json --file Cargo.lock \
  --ignore RUSTSEC-2026-0204 --ignore RUSTSEC-2026-0258 \
  --ignore RUSTSEC-2026-0194 --ignore RUSTSEC-2026-0195 \
  --ignore RUSTSEC-2026-0185 --ignore RUSTSEC-2026-0235 \
  --ignore RUSTSEC-2026-0049 --ignore RUSTSEC-2026-0098 \
  --ignore RUSTSEC-2026-0099 --ignore RUSTSEC-2026-0104
```

For fresh online verification use a separate database path and omit only
`--no-fetch`. Neither run disables yanked checks or filters severity/targets.
`cargo metadata --locked --no-deps` validates manifest/lock consistency; the
resolved macOS metadata and member list also verify that vendor crates are not
first-party workspace members. No rustls 0.22 or zip below 9 remains in the root
lockfile. The archived upstream vendor lockfiles are retained for byte-level
provenance and are not the product's resolved lockfile.

| Dependency family | Before | After |
| --- | --- | --- |
| quinn-proto | 0.11.14 | 0.11.18 |
| rustls | 0.22.4 and 0.23.45 | 0.23.46 |
| zip | 2.4.2, 4.6.1, 5.1.1, 8.5.1 | 9.0.5 |
| rumqttc | 0.24.0 | 0.25.1 |
| tokio-rustls | 0.25.0 and 0.26.4 | 0.26.4 |
| rustls-native-certs | 0.7.3 and 0.8.3 | 0.8.3 |
| Serenity tokio-tungstenite | 0.21.0 | 0.24.0, URL support retained |
| unused tauri-plugin-updater | 2.10.1 | removed; custom updater retained |

## Compatibility decisions

- All three MQTT consumers use rumqttc's supported `use-rustls-no-provider`
  feature and the direct rustls dependency explicitly supplies ring. This avoids
  the new default's aws-lc selection. Both MQTT websocket features remain enabled.
  TLS client configuration explicitly selects ring; trusted-certificate and
  hostname verification remain active on normal connections. The existing
  explicitly insecure diagnostic paths are unchanged in purpose.
- Native certificate loading uses rustls-native-certs 0.8's `CertificateResult`:
  usable native roots survive individual bad certificates. Only an unusable
  store falls back to bundled roots, uncached so transient keychain failures
  can recover. Failed-load details remain in the fallback reason.
- zip 9 makes `name()` fallible. Extractors propagate filename errors; deployment
  artifact inspection classifies unreadable names as unknown, retaining manual
  confirmation. Existing traversal, mode preservation and archive roundtrips
  remain covered. zip 9 intentionally accepts legacy CP437 names; the regression
  fixture checks that compatibility. `tests/fixtures/archive-cp437.json` is a
  generated 119-byte ZIP represented as JSON bytes (one `éad.txt` entry with
  contents `fixture`), complying with the repository's no-archive commit rule.
- Two narrow parent patches retain complete official package contents and
  licenses. 181 of 182 Rust source files are byte-identical to their official
  archives; one upstream Rustdoc credential-shaped example is replaced with an
  obvious noncredential. All runtime code is unchanged. Alongside the two
  manifest changes this is the only source deviation. See
  [vendor provenance and retirement criteria](../../vendor/rust/README.md).
- The removed updater plugin had no production `UpdaterExt`, plugin command or
  JavaScript plugin invocation. The frontend invokes `check_update`,
  `download_and_install_update` and `restart_app`. The generated capability
  schema change removes only `updater:default`; remaining permissions are equal.

## Validation

Rust checks used the repository wrappers, Rust 1.97.1 and the isolated worktree's
own `.cargo-target` (daemon uses its `sidecar-amuxd` subdirectory). Test/analysis
runs used `CI=1`, `TAURI_CONFIG='{"bundle":{"externalBin":[],"resources":[]}}'`
to omit bundle-only sidecar/resource staging. `SHERPA_ONNX_LIB_DIR` pointed to
existing read-only official 1.13.7 macOS static libraries. `DOCS_RS` was not set:
desktop test executables linked the real Sherpa native libraries.

| Check | Result |
| --- | --- |
| `node scripts/rust-cli.js test -p teamclu -p teamclu-gateway -p teamclu-transport --locked` | Pass: desktop 469 unit + 1 main + 2 integration; gateway 198 unit + 1 local Discord integration; transport 19 unit |
| `node scripts/daemon-cargo.js test --locked -- --test-threads=1` | Pass: 7,751 invocations across binary and seven integration suites (included source tests repeat); existing NATS test returns early without its broker URL |
| Custom updater configuration tests | 6 pass; 3 app-launch UI tests excluded by explicit configuration-only filter |
| TLS regression | Trusted handshake succeeds; wrong host and untrusted certificate rejected; empty/malformed native-root stores handled |
| MQTT regression | Actual 64 KiB publish/receive loopbacks over TCP and websocket pass, including `/mqtt` path and protocol negotiation |
| Discord regression | Patched Serenity performs a local websocket handshake and sends Identify/Heartbeat; no external Discord account or messages |
| Updater regression | Valid signatures (plain, CRLF, base64) accepted; tampered payload/invalid signature/key rejected; macOS tar.gz format extracted |
| Archive regression | Legacy CP437, existing traversal, executable modes, roundtrips and deployment artifact inspection exercised |
| `cargo fmt --check --manifest-path apps/desktop/Cargo.toml` | Pass (exact CI scope) |
| `node scripts/rust-cli.js clippy --manifest-path apps/desktop/Cargo.toml --all-targets --locked -- -D warnings` | Pass |
| Frontend `tsc --noEmit` via typecheck script | Pass |
| Release `scripts/verify-reqwest-rustls.sh` | Pass; unified daemon/introspect reqwest remains rustls-only |
| Official source/checksum/license/manifest comparison | Pass; 196 files checked: two manifest differences and one documented Rustdoc literal redaction |

The existing two transport NATS tests and one daemon NATS retained test return early when `AMUXD_NATS_TEST_URL`
is absent; they are not claimed as live broker coverage. Two existing doc tests
are ignored. Upstream Serenity emits three existing deprecation warnings (a futures method,
an event type and a message field). The daemon test build also reports existing
first-party unused/dead-code warnings; passing tests do not imply warning-free
output. Clippy's first-party gate still passes. Full `cargo fmt --all --check`
is broader than CI: its comparison records 79 entries representing 64 unique
normalized file paths, all unchanged from the baseline (including local MCP
plugin formatting). No unrelated formatting changes were made.

Cross-platform limits: this host verifies macOS arm64, not Windows/Linux native
builds. Hosted CI must exercise Windows installer staging/revalidation and Linux
build paths. The Windows ZIP-rejection regression is compiled/run on Windows;
it does not run on macOS. Neither the dormant Sherpa iOS XCFramework extraction
path nor live speech inference/model loading was exercised. The websocket test
covers Serenity's handshake and outbound wire protocol, not live Discord auth or
inbound event handling. No security gate or product capability was waived.

## Resolved dependency inventory

The following package/version additions are the targeted migrations and their
required transitive graph. In particular zip 9 brings nix 0.31.3, whose
`libc >=0.2.186` requirement necessitates the libc refresh. Existing unrelated
locked dependencies were not broadly updated. Test dependencies use versions
already present in the graph (rcgen 0.14 and tokio-tungstenite 0.29).

| Added/resolved package | Version |
| --- | --- |
| aes | 0.9.3 |
| async-tungstenite | 0.29.1 |
| block-buffer | 0.12.1 |
| cipher | 0.5.2 |
| cmov | 0.5.4 |
| const-oid | 0.10.2 |
| constant_time_eq | 0.6.1 |
| cpubits | 0.1.1 |
| crypto-common | 0.2.2 |
| ctutils | 0.4.3 |
| digest | 0.11.3 |
| hmac | 0.13.0 |
| hybrid-array | 0.4.15 |
| inout | 0.2.5 |
| libc | 0.2.191 |
| lzma-rust2 | 0.22.0 |
| nix | 0.31.3 |
| pbkdf2 | 0.13.0 |
| ppmd-rust | 1.5.1 |
| quinn-proto | 0.11.18 |
| rand_pcg | 0.10.2 |
| rumqttc | 0.25.1 |
| rustls | 0.23.46 |
| sha1 | 0.11.0 |
| sha2 | 0.11.1 |
| tokio-tungstenite | 0.24.0 |
| tungstenite | 0.24.0 |
| tungstenite | 0.26.2 |
| ws_stream_tungstenite | 0.15.0 |
| zip | 9.0.5 |
| zstd | 0.14.3 |
| zstd-safe | 8.2.0 |
| zstd-sys | 2.1.2+zstd.1.5.7 |

The parallel daemon run exposed an unchanged shared HOME/config race in
`remote_tools::mcp_config::tests::remote_tools_config_path_is_host_level`; the
exact isolated test and complete serial run passed. No test was removed.
The JSON representation of the CP437 fixture was then checked with targeted
desktop and daemon tests. A byte-preserved upstream Serenity comment contains
one trailing-whitespace line; first-party staged diff checks pass.
