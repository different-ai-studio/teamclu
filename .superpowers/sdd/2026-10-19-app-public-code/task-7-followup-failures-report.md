# Task 7 follow-up: acceptance test failures

## Status and authority

Implementation complete; focused checks pass. Controller owns independent review and the one final integrated full-suite acceptance run. This report does **not** claim those later acceptance steps have passed.

- Approved task: `/tmp/app-code-followup-requirements.md`, resumed Task 7, user instruction dated 2026-10-20.
- Worktree: `/Users/dengwei/.codex/worktrees/app-public-code/teamclu`.
- Branch: `codex/app-public-code-implementation`.
- Starting commit: `a7cefd31d227337c57c717d245b3fbe15742bf3e`.
- Read requirements first, frontend/Rust diagnosis reports, repo `AGENTS.md` and `CLAUDE.md`, `agent-contract.md`, `constraints.md`, systematic-debugging/TDD/writing-good-tests/verification-before-completion skills. `SDLC.md` absent.
- No subagents spawned. No original-checkout edits, dependency installation through linked Node directories, push, PR, merge, deployment, live DB/account writes, existing VM mutation, or native approval popup launched by this implementer.
- Commit subject: `test: make acceptance fixtures and preflight checks deterministic`; final handoff supplies the commit hash. Report and implementation are committed together.

## Root causes and changes

### Backend deployment environment fixture

`finalizeDeploy` now gets `PORT` from the parsed deployment start declaration. The legacy test fixture omitted that declaration, so there was no platform port override: an injected user `PORT: 1` survived, and no-user-env omitted `PORT` entirely. This fixture no longer represented the real deployment input.

Changed only `services/fc/test/app-env.test.ts`: import and call `parseAppDeployDeclaration` with build `{ kind: "node", output: ".output" }` and start `{ entry: "server/index.mjs", port: 9000 }`. The user-env delivery, platform override, and exact no-user-env assertions remain unchanged. No unrelated original-checkout runtime/daemon draft was imported.

### Frontend passive-effect synchronization

Finding the offline DOM notice did not guarantee React had installed its passive `online` listener. The synthetic online event could be lost before subscription, leaving the offline notice present until the unchanged default `waitFor` timeout. The working pattern is asynchronous `act` around the initial render, which flushes the initial rejected load and resulting subscription.

Changed only the initial render of `reloads on its own once the network comes back` in `DaemonGeneralSection.offline.test.tsx` to `await act(async () => { render(...) })`, with a short explanation. Every behavioral assertion, the online event itself, and default timeout remain. Production component unchanged. No permanent repetition or listener-implementation assertion was added.

### Native OS resolver and external HTTPS assumptions

The OS resolver in this environment returns an address for the former `.invalid` test hostname. The production resolver correctly accepted the nonempty result, while the test expected public-DNS reservation rules to control the local resolver. The `example.com` and `badssl.com` tests also coupled acceptance to Internet/proxy availability; the badssl test could pass for an unrelated transport error.

`webview.rs` now has small module-private seams in its existing production path:

- `ensure_http_host_resolvable_with`: passes the unchanged OS resolver result through the existing success/empty/error handling. The normal wrapper still uses `ToSocketAddrs`.
- `preflight_client_builder`: shares the unchanged request/connect 3s budgets, user agent, default backend, and certificate/hostname verification policy.
- `probe_http_url`: sends the real HEAD request and retains the typed transport error chain until the existing outer error formatting.
- `apply_preflight_policy`: applies the same compile-time macOS failure gate and nonmacOS advisory logging to the probe result.

Tests inject only resolver outcomes or a real HTTP client configured for a loopback fixture (`no_proxy`, explicit local host mapping, and optionally a dedicated test CA). No public API, global hook, special `.invalid` behavior, TLS-security relaxation, production backend override, timeout increase, retries, test skips, or app-code behavior change was introduced.

Deterministic native coverage now exercises resolver error, empty result, nonempty result, IPv4/IPv6 and non-HTTP no-lookup bypass; actual loopback HEAD responses 204/404/405 and user agent; trusted matching TLS success; trusted wrong-name TLS rejection with certificate-name evidence; untrusted-root rejection with certificate-chain evidence; non-HTTP asynchronous bypass; and platform success/failure policy. Wrong-name and untrusted-root tests cannot pass on an arbitrary timeout or connection failure.

## Runtime certificate fixture amendment

Initial embedded RSA CA/leaf/key fixture experiments exposed the **actual default production TLS backend** on this macOS workspace: feature unification makes reqwest use native TLS. A broad 2020–2120 leaf was rejected with native OSStatus `-67901` (certificate validity period exceeds the maximum), including in the matching-name success control. A shortened static leaf made matching-name TLS succeed, but an annual fixture expiry would introduce another future acceptance failure.

The controller explicitly amended dependency scope to allow a minimal dev-only runtime certificate generator. Final tests use `rcgen` with default features disabled and only `crypto`/`ring`, plus the originally approved test-only `tokio-rustls` with `ring`/`tls12`. A fresh CA and signed SAN `preflight.test` leaf/key are generated in memory on each run, with validity from wall-clock now minus one day through now plus 30 days. They are never persisted or trusted globally. No external openssl executable, Python package, checked-in private key, fixture regeneration, or static-certificate expiry maintenance is required. Production TLS backend remains unchanged.

With native TLS the actual wrong-host error chain contains OSStatus `-67602` (`A host name mismatch has occurred.`); the actual missing-root error chain contains `-25318` (`One or more certificates required to validate this certificate cannot be found.`). Assertions recognize these certificate-specific codes and equivalent specific Rustls/native error wording, rather than accepting a generic transport error. macOS error-code meaning was checked against installed Security framework source/constants. Rcgen parameter/signing interfaces were checked against the [official CertificateParams docs](https://docs.rs/rcgen/latest/rcgen/struct.CertificateParams.html) and [Issuer docs](https://docs.rs/rcgen/0.14.10/rcgen/struct.Issuer.html).

### Dependency scope

- Direct dev-only additions: `rcgen 0.14` (resolved 0.14.10, no PEM or X509 parser feature), `tokio-rustls 0.26` (existing lock package 0.26.4).
- Cargo.lock additions: `rcgen 0.14.10`, `yasna 0.6.0`, `bit-vec 0.9.1`, and Cargo's optional-dependency locking entries `x509-parser 0.18.1`, `asn1-rs 0.7.2`, `asn1-rs-derive 0.6.0`, `asn1-rs-impl 0.2.0`, `der-parser 10.0.0`, `oid-registry 0.8.1`, `rusticata-macros 4.1.0`.
- Existing `bit-vec 0.8.0` remains and one dependency reference is disambiguated as `bit-vec 0.8.0`.
- Package name/version comparison against HEAD confirmed **no prior locked packages removed or version changed**.
- `cargo tree -p teamclu --locked -e normal,dev` shows rcgen under `[dev-dependencies]`; only rcgen/yasna appeared in compilation, and the parser is absent from the enabled tree. No unrelated upgrade.

The first Cargo index operation stalled with LibreSSL `SSL_ERROR_SYSCALL`/slow-transfer errors. Only that process was stopped. The registry operation succeeded using the existing local proxy `http://127.0.0.1:7897` supplied by the database-probe agent, set for that command only with normal HTTPS verification. No shared/global config changed. Logs: `/tmp/task7-followup-cargo-dependency.log`, `/tmp/task7-followup-cargo-dependency-proxy.log`, `/tmp/task7-followup-rust-runtime-tls-green.log`.

## RED/GREEN evidence and exact focused commands

All commands use existing direct Node/compiler binaries, not pnpm automatic installation. Worktree writes/build locks/test cache operations used approved elevated execution.

### Backend

Directory: `<worktree>/services/fc`.

```
node --import tsx --test test/app-env.test.ts
```

RED: **8 pass / 2 fail**, `/tmp/task7-followup-backend-red.log`:

- `a user row that reached the table anyway cannot shadow the platform`: actual `1`, expected `9000`.
- `no user env leaves the function's environment exactly as before`: actual lacked `PORT: 9000`.

After the fixture correction:

```
node --import tsx --test test/app-env.test.ts 'test/provisioning/*.test.ts'
node node_modules/typescript/bin/tsc -p tsconfig.test.json
```

GREEN: **238/238**, no skipped tests, `/tmp/task7-followup-backend-green.log`; typecheck exit 0, empty `/tmp/task7-followup-backend-typecheck.log`.

### Frontend

Directory: `<worktree>/packages/app`.

```
node node_modules/vitest/vitest.mjs run src/components/settings/__tests__/DaemonGeneralSection.offline.test.tsx
```

Initial ordinary baseline: **3/3** (the failure is intermittent), `/tmp/task7-followup-frontend-baseline.log`.

For fresh RED stress evidence, copied the unmodified test to the already isolated `/tmp/app-code-frontend-probe/packages/app` snapshot and changed **only** the recovery case to 1,000 parameterized repetitions. No listener spy, extra assertion, deadline change, or production source change. Snapshot command:

```
node node_modules/vitest/vitest.mjs run src/components/settings/__tests__/DaemonGeneralSection.offline.test.tsx --configLoader native --reporter dot
```

RED: **1 fail / 1001 pass**, at the original notice-removal `waitFor` assertion, `/tmp/task7-followup-frontend-stress-red.log`. After applying only the async-act synchronization to the same snapshot: **1002/1002**, `/tmp/task7-followup-frontend-stress-green.log`.

Final ordinary worktree command above: **3/3**, `/tmp/task7-followup-frontend-green.log`.

```
node node_modules/typescript/bin/tsc --noEmit
```

GREEN: exit 0, empty `/tmp/task7-followup-frontend-typecheck.log`.

The installed Vite emits its preexisting advisory about `__dirname` with its future native config loader; the repaired test adds no warning.

### Native

Directory: `<worktree>`. All native commands below have the exact environment prefix:

```
CI=1 RUSTC_WRAPPER=/usr/bin/env TAURI_CONFIG='{"bundle":{"resources":[],"externalBin":[]}}' SHERPA_ONNX_LIB_DIR=/Users/dengwei/git/teamclu/.cargo-target/sherpa-onnx-prebuilt/sherpa-onnx-v1.13.7-osx-arm64-static-lib/lib
```

Existing RED reproduction:

```
node scripts/rust-cli.js test -p teamclu --lib --locked ensure_http_ -- --nocapture
```

**5 pass / 1 fail**, `ensure_http_host_resolvable_rejects_unresolvable_host: unresolvable host: ()`, `/tmp/task7-followup-rust-baseline-red.log`.

Tests were written before production seams. Initial test-first RED:

```
node scripts/rust-cli.js test -p teamclu --lib --locked commands::webview::tests:: -- --nocapture
```

Compilation failed with 13 `E0425` errors for intentionally missing `ensure_http_host_resolvable_with`, `preflight_client_builder`, `probe_http_url`, and `apply_preflight_policy`, `/tmp/task7-followup-rust-seams-red.log`. Those seams were then implemented minimally.

Fixture investigation, retained as diagnostic failures rather than hidden:

- Initial static broad-validity attempt: **21 pass / 3 fail**, all TLS fixtures rejected on native certificate lifetime `-67901`, `/tmp/task7-followup-rust-seams-green.log` (file name reflects intended phase; result is RED).
- Shorter static leaf: **3 pass / 2 fail**, matching success control passed; rejection tests failed because their initial Rustls-only `NotValidForName`/`UnknownIssuer` assertions saw native certificate-specific errors instead, `/tmp/task7-followup-rust-tls-diagnostic.log`.
- Runtime-generated final fixture, with controller-approved rcgen dependency resolution: **10/10**, `/tmp/task7-followup-rust-runtime-tls-green.log`. This one command omitted `--locked` solely to let Cargo resolve the newly authorized dependency and used command-scoped local proxy variables.

Meaningful mutation regressions then ran serially against the shared production helpers, with a `finally` restoration of source:

1. Added `danger_accept_invalid_hostnames(true)` temporarily to **the shared production client builder**. Ran `... test -p teamclu --lib --locked ensure_http_url_reachable_rejects_trusted_wrong_hostname -- --nocapture`. **0 pass / 1 fail** at `trusted certificate with wrong SAN must reject: ()`, proving hostname verification removal is caught. `/tmp/task7-followup-tls-mutation-red.log`.
2. Temporarily bypassed resolver error and empty-result rejection in **the shared production resolver helper**. Ran `... test -p teamclu --lib --locked ensure_http_host_resolvable_rejects_ -- --nocapture`. **0 pass / 2 fail**, both expected `Err` assertions received `Ok`. `/tmp/task7-followup-dns-mutation-red.log`.
3. Mutation harness exited 0 only after confirming both runs were assertion failures (`test result: FAILED`), not compilation failures. `/tmp/task7-followup-mutation-summary.log`.

Both mutations were removed before final verification:

```
node scripts/rust-cli.js test -p teamclu --lib --locked commands::webview:: -- --nocapture
```

Final GREEN: **29/29**, zero skipped/ignored, **0.06s** test time; `/tmp/task7-followup-rust-final-green.log`. Includes identity-origin tests plus all webview module tests. Existing native build warnings remain: package-local profiles ignored, absent release Cloud API URL in check/test config, and upstream block/imap-proto future incompatibility. No new final source warning.

Dependency verification:

```
node scripts/rust-cli.js tree -p teamclu --locked -e normal,dev
```

Exit 0, `/tmp/task7-followup-native-dependency-tree.log`.

## Self-review and boundaries

- Reviewed full source diff and dependency diff. `git diff --check` passes.
- Only five existing paths changed: backend fixture, frontend test, native webview module, desktop Cargo.toml, Cargo.lock. This task report is the additional artifact.
- All production changes are private seam extractions in the existing preflight call path. OS lookup, IP/non-HTTP handling, 3s async DNS deadline, 3s connect/request budgets, user agent, default TLS backend/verification, any-status success, user-facing error formatting, and platform logging/gating retain existing behavior.
- TLS and HTTP fixtures bind `127.0.0.1:0`, use explicit local mappings and no environment proxy, and require actual requests/handshakes. Certificate tests inspect certificate-specific error chains. Tests do not rely on the Internet, public DNS reservations, runtime openssl, global roots, or test-run retries.
- Test helpers/certificate generation remain within existing `#[cfg(test)] mod tests`. No production API or global hook was added. No static fixtures remain.
- The wrong-host mutation and matching-host success control jointly rule out accepting arbitrary TLS errors or blanket rejection; DNS mutation verifies both rejection branches.
- No application identity, app-code semantics, native approval handler, migration/schema, runtime/daemon draft, original checkout, or live service was changed.

## Remaining acceptance work / limits

- The controller requested **focused checks here and one integrated full-suite run later**, after all fixes and independent review. Full backend/frontend/native suites are therefore intentionally not rerun by this implementer; no full-suite pass is claimed.
- Native verification is on macOS arm64. NonmacOS advisory code and native error wording remain host-dependent until those platforms execute the tests; no Windows/Linux execution is claimed.
- The runtime certificate fixture eliminates annual expiry but, like TLS itself, presumes a functioning system clock during each short test run.
- Independent review, overall Task 7 acceptance, and native popup-harness evidence are controller-owned follow-up work. Native target was explicitly released to the harness agent after the final focused run.
