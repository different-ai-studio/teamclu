# App deployment discovery — local validation (2026-09-28)

Scope: the final app-deployment-discovery branch through `47b04bbf`, including the integration-review fixes. This is local automated validation only. No cloud app, self-host service, or live database was changed.

## Automated results

| Command | Result |
| --- | --- |
| FC `node --import tsx --test "test/**/*.test.ts"` | 1,567 passed, 0 failed, 13 skipped because local Supabase was unreachable (`TypeError: fetch failed`). |
| FC `tsc -p tsconfig.test.json` | Passed. |
| `redocly lint docs/openapi/teamclu-api.v1.yaml` | Valid with 10 existing warnings. |
| App `vitest run` | 4,100 passed, 0 failed, 10 skipped across 603 files. |
| App `tsc --noEmit` | Passed. |
| `node scripts/daemon-cargo.js test --bin amuxd -- --test-threads=1` | 1,894 passed, 0 failed with local loopback access. |
| `node scripts/rust-cli.js test -p teamclu --lib -- --test-threads=1` | 432 passed, 0 failed on full rerun with local loopback access and shell-only Tauri resource override. |
| `node scripts/rust-cli.js test -p teamclu-introspect` | 105 passed, 0 failed. |

The worktree's pnpm dependency links were damaged by a blocked reinstall, so FC and app checks used their already-installed local binaries; the app tests temporarily linked the original checkout's compatible `node_modules` and restored the prior worktree cache afterward. The first desktop full-suite run had one failure in an unchanged test that calls `https://example.com`; that test passed alone and the full suite passed on rerun. Desktop commands used `CI=1`, `RUSTC_WRAPPER=/usr/bin/env`, and a shell-only `TAURI_CONFIG` to omit unavailable bundled resources. Local mock-server tests needed loopback access. No workaround was committed.

The focused daemon build tests cover macOS and Windows hosts with mismatched native entry binaries, a missing declared entry/output, Linux ARM64 `.so` and `.so.1`, a cross-built Linux x86_64 native library, unclassifiable native bytes, and a container image metadata mismatch that stops before push. The verifier runs before archive upload or registry push. `unknown` stops desktop and web finalization; the previous live app stays serving.

The missing-output build path has a direct regression for its pre-upload error. The archive verifier inspects ZIP/JAR members within a 4,096-member and 200 MiB budget, reading members through EOF so trailing corruption and CRC failures cannot yield `checked`. A known wrong-architecture native member fails. Nested archives and recognizable tar/gzip, bzip2, xz, zstd, and 7z content report `unknown` rather than claiming compatibility.

## Manual rollout cases

| Case | Status | Reason |
| --- | --- | --- |
| Fresh Node app and live URL | Untested | Requires separately authorized self-host rollout and disposable app. |
| Existing live Node redeploy and rollback preservation | Untested | Requires separately authorized self-host rollout. |
| Python data app with database and authentication behavior | Untested | Requires separately authorized self-host rollout and synthetic fixture. |
| Java regional catalog and layer probing | Untested | Read-only live discovery has not been run for Task 6. |
| Second selected OS host | Untested | No Windows daemon host was available; platform fixtures are automated. |

An `unknown` artifact cannot be finalized by this client revision. The current deploy API has no way to attach target-runtime test evidence and override that gate, so an unclassifiable artifact requires a follow-up design before it can publish. Header inspection also does not prove a process boots or HTTP/data/auth behavior works; those remain manual rollout checks.
