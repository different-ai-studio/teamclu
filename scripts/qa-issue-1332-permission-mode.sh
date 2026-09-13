#!/usr/bin/env bash
# QA harness for issue #1332 — session permission mode daemon sync.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== Issue #1332 static wiring checks =="
rg -q 'permission_mode = 10' proto/teamclu.proto
rg -q 'SessionPermissionModeRequest' proto/teamclu.proto
rg -q "case: 'sessionPermissionMode'" packages/app/src/lib/daemon/teamclu-rpc.ts
rg -q 'permissionMode: args.permissionMode' packages/app/src/lib/daemon/teamclu-rpc.ts
rg -q 'handle_session_permission_mode' apps/daemon/src/daemon/server/runtime_lifecycle.rs
rg -q 'auto-allow full-access pi confirm' apps/daemon/src/runtime/pi_rpc/events.rs
rg -q 'clear_pending_permissions_for_session' apps/daemon/src/runtime/pi_rpc/mod.rs
rg -q 'dedup reuse permission sync' apps/daemon/src/daemon/server/runtime_lifecycle.rs
echo "  static checks: OK"

echo "== cargo: permission_policy =="
cargo test -p amuxd permission_policy --quiet

echo "== vitest: permission + session-create =="
(cd packages/app && pnpm exec vitest run \
  src/components/chat/__tests__/PermissionApprovalModeSelect.test.tsx \
  src/lib/session/__tests__/session-create.test.ts \
  src/lib/session/__tests__/session-permission-mode.test.ts \
  src/lib/session/__tests__/session-permission-mode-wire.test.ts \
  --silent)

echo "== QA harness finished =="
