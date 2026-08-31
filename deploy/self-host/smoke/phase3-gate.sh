#!/bin/sh
# Is it safe to delete LiteLLM yet?
#
# Phase 3 removes the container, its routes, its env and its database. Every
# one of those is load-bearing until the last client has moved, and "have they
# moved?" is not a question anyone can answer from memory. This turns the five
# conditions in docs/specs/2026-08-28-team-ai-gateway-design.md §11.5 into
# something runnable.
#
# Read-only. Exits non-zero when ANY gate fails, so it can front the deletion
# in CI or a runbook.
#
# Usage (on the deploy box):
#   sh deploy/self-host/smoke/phase3-gate.sh
#   MIN_CLIENT_OK=1 OPS_UI_OK=1 sh .../phase3-gate.sh   # after confirming 4 & 5
set -eu

PSQL="docker compose exec -T db psql -qtA -U postgres"
FAILED=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILED=1; }
warn() { printf '  \033[33m????\033[0m  %s\n' "$1"; FAILED=1; }

echo "Phase 3 gate — may LiteLLM be deleted?"
echo

# ── 1. the replacement is actually running ──────────────────────────────────
# Not in §11.5 as written, but implied by all of it: every other check is
# meaningless if the thing meant to take over was never deployed.
if docker compose ps ai-gateway 2>/dev/null | grep -q healthy; then
  pass "ai-gateway container is up and healthy"
else
  fail "ai-gateway is not running — nothing has taken over yet"
fi

# ── 2. every team points at the new gateway ─────────────────────────────────
# The cutover lever is one column. A team still on a /llm/ base URL would lose
# its AI the moment the container goes.
STALE=$($PSQL -d postgres -c "
  select count(*) from amux.team_workspace_config
   where llm_base_url is not null and llm_base_url like '%/llm/%'" 2>/dev/null || echo "?")
case "$STALE" in
  0) pass "no team still points at the LiteLLM base URL" ;;
  ?) warn "could not read team_workspace_config" ;;
  *) fail "$STALE team(s) still point at /llm/ — cutting over is Phase 1's job, not this one" ;;
esac

# Teams with NO explicit base url fall back to AI_GATEWAY_ENDPOINT, so that env
# has to have moved too, or the fallback still resolves to LiteLLM.
if grep -qE '^AI_GATEWAY_ENDPOINT=.+/ai(/|$)' .env 2>/dev/null; then
  pass "AI_GATEWAY_ENDPOINT points at the new gateway (covers teams with no override)"
else
  fail "AI_GATEWAY_ENDPOINT does not point at /ai — teams without an explicit base URL would break"
fi

# ── 3. the new path carries real traffic, the old one carries none ──────────
NEW=$($PSQL -d postgres -c "
  select count(*) from amux.ai_usage_logs where created_at > now() - interval '14 days'" 2>/dev/null || echo "?")
case "$NEW" in
  ?|0) fail "no usage recorded through the new gateway in 14 days — there is no evidence it works" ;;
  *)   pass "$NEW request(s) through the new gateway in the last 14 days" ;;
esac

OLD=$($PSQL -d _litellm -c '
  select count(*) from "LiteLLM_SpendLogs" where "startTime" > now() - interval '"'"'14 days'"'"'' 2>/dev/null || echo "?")
case "$OLD" in
  0) pass "LiteLLM has served nothing for 14 days" ;;
  ?) warn "could not read _litellm — confirm by hand before deleting the database" ;;
  *) fail "$OLD request(s) still went through LiteLLM in the last 14 days — someone is still on it" ;;
esac

# ── 4. no supported client still reads litellmTeamId ────────────────────────
# Desktop and iOS do not update in lockstep with the server, so this one cannot
# be measured from here. It is a release-manager fact, asserted deliberately.
if [ "${MIN_CLIENT_OK:-}" = "1" ]; then
  pass "minimum supported client no longer reads litellmTeamId (asserted)"
else
  fail "set MIN_CLIENT_OK=1 once the oldest supported desktop/iOS build no longer reads litellmTeamId"
fi

# ── 5. nobody needs the LiteLLM admin UI ────────────────────────────────────
# Deleting the container also deletes /ui — the new gateway has no admin UI by
# design (catalog is a file, balances live in the app).
if [ "${OPS_UI_OK:-}" = "1" ]; then
  pass "operations confirmed the LiteLLM admin UI is no longer needed (asserted)"
else
  fail "set OPS_UI_OK=1 once operations confirm they do not need the LiteLLM admin UI"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "GATE OPEN — Phase 3 deletion may proceed."
else
  echo "GATE CLOSED — do not delete LiteLLM."
  echo "Each FAIL above is a way this deletion takes team AI down."
fi
exit "$FAILED"
