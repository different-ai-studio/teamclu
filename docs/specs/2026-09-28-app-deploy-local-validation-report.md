# App deployment discovery — local validation (2026-09-28)

Scope: Task 6 selected-daemon artifact checks on branch `design/app-deploy-discovery-impl`. This is local automated validation only. No cloud app, self-host service, or live database was changed.

## Automated results

| Command | Result |
| --- | --- |
| `pnpm --dir services/fc test` | 1,576 tests: 1,563 passed, 0 failed, 13 skipped because local Supabase was unreachable (`TypeError: fetch failed`). |
| `pnpm --dir services/fc typecheck` | Passed. |
| `pnpm --dir services/fc openapi:lint` | Passed with 10 existing warnings. |
| `pnpm typecheck` | Passed before the final web gate edit. Afterward, the worktree's pnpm dependency links were removed by a failed dependency status check; an offline reinstall lacked `@tauri-apps/cli`. The equivalent app command, `tsc --noEmit -p tsconfig.json`, passed using the original checkout's compatible binaries linked into this worktree. |
| `node scripts/daemon-cargo.js test --bin amuxd` | Final sequential elevated run: 1,881 passed, 0 failed. The first sandbox run had 1,765 passed and 112 failed when local test sockets were denied (`Operation not permitted`). An earlier elevated parallel run passed 1,879/1,879 before the final push-order and opaque-entry tests; a later parallel run had one unrelated temporary-home race. |
| `node scripts/rust-cli.js test -p teamclu-introspect` | 105 passed, 0 failed with `CI=1 RUSTC_WRAPPER=/usr/bin/env`. The initial wrapper run stopped while trying to download the FunASR sidecar through an unavailable proxy. |
| `node scripts/rust-cli.js test -p teamclu --lib` | 429 passed, 0 failed with `CI=1`, a shell-only `TAURI_CONFIG` omitting unavailable bundled resources, and approved loopback access. The ordinary wrapper was blocked on a FunASR download; the sandbox run had 404 passed and 25 socket-permission failures. The new desktop gate passed its focused linked test. |
| App artifact gate unit tests | 2 passed, 0 failed, invoked using the original checkout's compatible Vitest binary after the worktree dependency links disappeared. |

The focused daemon build tests cover macOS and Windows hosts with mismatched native entry binaries, a missing declared entry/output, Linux ARM64 `.so` and `.so.1`, a cross-built Linux x86_64 native library, unclassifiable native bytes, and a container image metadata mismatch that stops before push. The verifier runs before archive upload or registry push. `unknown` stops desktop and web finalization; the previous live app stays serving.

Review follow-up: the missing-output build path already had an output guard; a direct regression now covers its pre-upload error. The archive verifier now inspects ZIP/JAR members within a 4,096-member and 200 MiB declared-uncompressed budget. A known wrong-architecture native member fails; nested or unreadable content remains `unknown`. Focused daemon build tests after this change: 54 passed, 0 failed. The full 1,881-test daemon result above predates this review follow-up; the focused run compiled and exercised the changed module.

Second review follow-up: ZIP/JAR members now read through EOF within the same 200 MiB cap so trailing corruption and CRC failures cannot yield `checked`. The verifier reads a bounded 512-byte prefix to detect native headers and opaque archive magic, including tar's `ustar` marker; tar/gzip and other recognizable opaque compressed formats report `unknown` at the top level or within ZIP/JAR content. The focused daemon build suite added regressions for a corrupt member CRC, nested/top-level `.tar.gz`/`.tgz`, and tar magic under opaque names: 57 passed, 0 failed. The full 1,881-test result predates these review fixes.

## Manual rollout cases

| Case | Status | Reason |
| --- | --- | --- |
| Fresh Node app and live URL | Untested | Requires separately authorized self-host rollout and disposable app. |
| Existing live Node redeploy and rollback preservation | Untested | Requires separately authorized self-host rollout. |
| Python data app with database and authentication behavior | Untested | Requires separately authorized self-host rollout and synthetic fixture. |
| Java regional catalog and layer probing | Untested | Read-only live discovery has not been run for Task 6. |
| Second selected OS host | Untested | No Windows daemon host was available; platform fixtures are automated. |

An `unknown` artifact cannot be finalized by this client revision. The current deploy API has no way to attach target-runtime test evidence and override that gate, so an unclassifiable artifact requires a follow-up design before it can publish. Header inspection also does not prove a process boots or HTTP/data/auth behavior works; those remain manual rollout checks.
