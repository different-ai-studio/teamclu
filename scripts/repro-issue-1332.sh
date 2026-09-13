#!/usr/bin/env bash
# Reproduce issue #1332 mechanism at the daemon layer (no desktop GUI required).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== Issue #1332 repro: permission policy merge (user vs gateway) =="
cargo test -p amuxd resolve_for_session -- --nocapture 2>&1 | tail -5

echo ""
echo "== Issue #1332 repro: Ask → ACP vs Full → local auto-allow =="
cargo test -p amuxd issue_1332_confirm -- --nocapture 2>&1 | tail -15

echo ""
echo "== Full QA harness =="
"$ROOT/scripts/qa-issue-1332-permission-mode.sh"

echo ""
echo "Manual live check (with running desktop + amuxd + pi):"
echo "  1. Ordinary session, select 完全访问, run agent with bash tool."
echo "  2. grep amuxd logs: expect 'auto-allow full-access pi confirm', NOT only 'permission granted via ACP'."
echo "  3. Toggle 默认 mid-session: next tool should show permission UI / ACP again."
