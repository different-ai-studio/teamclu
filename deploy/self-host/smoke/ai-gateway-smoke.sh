#!/bin/sh
# Post-deploy smoke for services/ai-gateway. Runs alongside litellm-smoke.sh --
# both gateways are live until Phase 3 (design §11.5).
#
# Deliberately does NOT spend upstream tokens: a completion needs a real member
# JWT, which this script has no way to mint. What it proves is that the service
# is up, its catalog validated at boot, and the authorization gate is closed.
# The completion path is covered by services/ai-gateway/test/e2e.test.ts.
set -eu

BASE="${AI_GATEWAY_BASE:-http://127.0.0.1:4001}"
fail() { echo "ai-gateway-smoke: FAIL — $1" >&2; exit 1; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@"; }

echo "ai-gateway-smoke: base=$BASE"

[ "$(code "$BASE/healthz")" = "200" ] || fail "/healthz not 200"
echo "  ok  healthz"

# A booted gateway has already validated the catalog (missing tier, dangling
# backend reference, or absent provider key all abort startup), so reaching this
# point means the catalog is coherent.

T="00000000-0000-4000-8000-000000000000"
[ "$(code "$BASE/v1/teams/$T/models")" = "401" ] || fail "unauthenticated /models should be 401"
echo "  ok  unauthenticated request rejected"

[ "$(code -H 'Authorization: Bearer not-a-real-token' "$BASE/v1/teams/$T/models")" = "401" ] \
  || fail "garbage bearer token should be 401"
echo "  ok  invalid token rejected"

# The internal surface must never accept an end-user credential.
[ "$(code -H 'Authorization: Bearer not-a-real-token' "$BASE/internal/models")" = "401" ] \
  || fail "internal routes should reject a non-service token"
echo "  ok  internal routes gated by the service token"

if [ -n "${AI_GATEWAY_SERVICE_TOKEN:-}" ]; then
  [ "$(code -H "Authorization: Bearer $AI_GATEWAY_SERVICE_TOKEN" "$BASE/internal/models")" = "200" ] \
    || fail "internal /models should accept the service token"
  echo "  ok  internal /models serves the tier catalogue"
fi

echo "ai-gateway-smoke: PASS"
