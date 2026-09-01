#!/usr/bin/env sh
# Run the self-host E2E test suite against the running docker compose stack.
#
# Usage (from deploy/self-host/):
#   sh smoke/run-e2e.sh
#
# Discovers container IPs automatically via docker inspect.
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

FC_IP=$(docker inspect teamclaw-self-host-fc-1 \
  --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null || echo "")
KONG_IP=$(docker inspect supabase-kong \
  --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null || echo "")

[ -n "$FC_IP" ]   || { echo "FAIL: teamclaw-self-host-fc-1 not running"; exit 1; }
[ -n "$KONG_IP" ] || { echo "FAIL: supabase-kong not running"; exit 1; }

# ── Wait for PostgREST's schema cache ──────────────────────────────────────
#
# `docker compose up -d` restarts supabase-rest, which then rebuilds its schema
# cache from Postgres. Until that finishes every request through it answers 503
# `PGRST002 Could not query the database for the schema cache`. The deploy
# workflow waits for fc and caddy — but nothing waits for this, so a
# fast runner fires the suite into a warming database and every DB-backed test
# fails at `POST /v1/teams`, with the rest cascading off the team that was never
# created. That is a deploy that reports failure while the deployment is fine.
#
# supabase-rest has no healthcheck to depend on, so probe it directly: its root
# serves the OpenAPI document once the cache is loaded. Probing the container
# rather than going through Kong keeps this apikey-free.
REST_IP=$(docker inspect supabase-rest \
  --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null || echo "")

if [ -z "$REST_IP" ]; then
  # The all-in-one image runs PostgREST as a plain process, not its own
  # container. Nothing to probe — let the suite report whatever it finds.
  echo "note: supabase-rest container not found; skipping schema-cache wait"
else
  echo "=== wait for postgrest schema cache ==="
  i=0
  until [ "$i" -ge 60 ]; do
    code=$(curl -s -o /tmp/pgrst-probe.$$ -w '%{http_code}' -m 5 \
      "http://$REST_IP:3000/" 2>/dev/null || echo "000")
    if [ "$code" = "200" ] && ! grep -q PGRST002 /tmp/pgrst-probe.$$ 2>/dev/null; then
      rm -f /tmp/pgrst-probe.$$
      echo "  postgrest ready after ${i}s"
      break
    fi
    i=$((i + 1))
    sleep 1
  done
  rm -f /tmp/pgrst-probe.$$
  # Deliberately not fatal: if PostgREST is genuinely broken the suite's own
  # assertions say so with far better diagnostics than a bare timeout here.
  [ "$i" -lt 60 ] || echo "WARN: postgrest still not serving after 60s; running the suite anyway"
fi

# ── Wait for GoTrue through Kong ───────────────────────────────────────────
#
# After auth is recreated, Kong may still proxy to a dead upstream until it is
# restarted (the deploy workflow does that, but this wait catches any residual
# warm-up). Probe /auth/v1/health so token refresh in the first e2e suite does
# not fail spuriously.
echo "=== wait for gotrue via kong ==="
i=0
until [ "$i" -ge 30 ]; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 \
    "http://$KONG_IP:8000/auth/v1/health" 2>/dev/null || echo "000")
  if [ "$code" = "200" ]; then
    echo "  gotrue ready via kong after ${i}s"
    break
  fi
  i=$((i + 1))
  sleep 1
done
[ "$i" -lt 30 ] || echo "WARN: gotrue health via kong still not 200 after 30s; running the suite anyway"

cd "$REPO_ROOT/services/fc"
FC_E2E=1 \
FC_E2E_BASE_URL="http://$FC_IP:9000" \
FC_E2E_KONG_URL="http://$KONG_IP:8000" \
FC_E2E_ENV_FILE="$REPO_ROOT/deploy/self-host/.env" \
  node --import tsx --test test/self-host-e2e.test.ts
