#!/usr/bin/env sh
# Smoke-test the self-host amuxd daemon after deploy.
#
# Usage (from deploy/self-host/):
#   sh smoke/amuxd-smoke.sh
#
# Checks:
#   1. amuxd container is Up
#   2. recent logs show a successful start (no invite/bootstrap fatals)
#   3. /v1/healthz responds when the HTTP port file is present
set -eu

SH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SH_DIR"

[ -f .env ] || { echo "FAIL: $SH_DIR/.env not found"; exit 1; }

fails=0
ok()  { echo "  PASS  $1"; }
bad() { echo "  FAIL  $1"; fails=$((fails + 1)); }

echo "1. amuxd container running"
deadline=$(( $(date +%s) + 120 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if docker compose ps amuxd 2>/dev/null | grep -qE 'Up|running'; then
    break
  fi
  sleep 3
done
if docker compose ps amuxd 2>/dev/null | grep -qE 'Up|running'; then
  ok "container Up"
else
  bad "container not Up"
  docker compose ps amuxd || true
fi

echo "2. recent logs (no bootstrap fatals)"
deadline=$(( $(date +%s) + 120 ))
logs=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  logs="$(docker compose logs --tail=80 amuxd 2>&1 || true)"
  case "$logs" in
    *"no persisted identity and AMUXD_JOIN_TOKEN is empty"*) break ;;
    *"starting daemon"*|*"amuxd: starting daemon"*) break ;;
  esac
  sleep 5
done
printf '%s\n' "$logs" | tail -20
case "$logs" in
  *"no persisted identity and AMUXD_JOIN_TOKEN is empty"*)
    bad "missing AMUXD_JOIN_TOKEN on first boot"
    ;;
esac
case "$logs" in
  *"starting daemon"*|*"amuxd: starting daemon"*)
    ok "daemon start line present"
    ;;
  *)
    bad "no daemon start line in recent logs"
    ;;
esac

echo "3. HTTP health probe"
port="$(docker compose exec -T amuxd sh -c 'cat /state/.amuxd/run/amuxd.http.port 2>/dev/null || true' | tr -d '[:space:]' || true)"
if [ -n "$port" ]; then
  if docker compose exec -T amuxd sh -c "wget -qO- http://127.0.0.1:${port}/v1/healthz >/dev/null 2>&1 || curl -sf http://127.0.0.1:${port}/v1/healthz >/dev/null"; then
    ok "/v1/healthz on port ${port}"
  else
    bad "/v1/healthz failed on port ${port}"
  fi
else
  echo "  SKIP  HTTP port file not written yet (daemon may still be booting)"
fi

if [ "$fails" -gt 0 ]; then
  echo "amuxd-smoke: FAIL ($fails check(s))"
  exit 1
fi

echo "amuxd-smoke: PASS"
