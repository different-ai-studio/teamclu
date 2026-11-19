#!/usr/bin/env bash
# Quick health check for the self-host stack. Exit 0 when core services are OK.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${ENV_FILE:-.env}"
TRY_START=false

usage() {
  cat <<'EOF'
Usage: ./bootstrap/check.sh [options]

Options:
  --try-start   If fc/caddy are Created/stopped, attempt `compose up -d --no-deps`
  -h, --help    Show this help

Exit codes:
  0  Core stack healthy (FC /healthz OK; db, auth, kong, storage, migrate OK)
  1  One or more critical checks failed
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --try-start) TRY_START=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

use_podman_compose() {
  command -v podman-compose >/dev/null || return 1
  if ! command -v docker >/dev/null 2>&1; then
    return 0
  fi
  docker compose version 2>&1 | grep -q podman-compose
}

if use_podman_compose; then
  COMPOSE=( -f docker-compose.yml -f docker-compose.podman.yml )
  RUNTIME=podman
  RUN=( podman-compose --in-pod false "${COMPOSE[@]}" )
  RUNTIME_LABEL="podman-compose (--in-pod false)"
else
  COMPOSE=( -f docker-compose.yml )
  RUNTIME=docker
  RUN=( docker compose "${COMPOSE[@]}" )
  RUNTIME_LABEL="docker compose"
fi

# shellcheck disable=SC1090
env_val() {
  [ -f "$ENV_FILE" ] || return 0
  grep "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true
}
FC_DOMAIN="${FC_DOMAIN:-$(env_val FC_DOMAIN)}"
FC_DOMAIN="${FC_DOMAIN:-api.example.com}"
CADDY_HTTP_PORT="${CADDY_HTTP_PORT:-$(env_val CADDY_HTTP_PORT)}"
CADDY_HTTP_PORT="${CADDY_HTTP_PORT:-8080}"

FAIL=0
WARN=0
ISSUES=()

ok()   { printf '  OK   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; FAIL=$((FAIL + 1)); ISSUES+=("$1"); }
warn() { printf '  WARN %s\n' "$1"; WARN=$((WARN + 1)); }
skip() { printf '  SKIP %s\n' "$1"; }

container_exists() {
  "$RUNTIME" inspect "$1" >/dev/null 2>&1
}

container_status() {
  "$RUNTIME" inspect "$1" --format '{{.State.Status}}' 2>/dev/null || echo missing
}

container_health() {
  "$RUNTIME" inspect "$1" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || echo missing
}

container_exit_code() {
  "$RUNTIME" inspect "$1" --format '{{.State.ExitCode}}' 2>/dev/null || echo "?"
}

check_running_healthy() {
  local name="$1" label="$2"
  if ! container_exists "$name"; then
    fail "$label — container missing ($name)"
    return
  fi
  local st hp
  st="$(container_status "$name")"
  hp="$(container_health "$name")"
  case "$st" in
    running)
      if [ "$hp" = "healthy" ] || [ "$hp" = "none" ]; then
        if [ "$hp" = "healthy" ]; then
          ok "$label — Up (healthy)"
        else
          ok "$label — Up"
        fi
      elif [ "$hp" = "starting" ]; then
        warn "$label — Up (health: starting) — wait and re-run check"
      else
        fail "$label — Up but health=$hp"
      fi
      ;;
    created)
      fail "$label — Created (never started) — Podman dependency graph or compose up incomplete"
      ;;
    stopped|dead)
      fail "$label — stopped — run: $RUNTIME start $name (or ${RUN[*]} up -d --no-deps ${name##*_})"
      ;;
    exited)
      fail "$label — Exited — run: $RUNTIME logs $name --tail 30"
      ;;
    *)
      fail "$label — status=$st health=$hp"
      ;;
  esac
}

check_migrate() {
  local name="teamclaw-self-host_migrate_1"
  if ! container_exists "$name"; then
    fail "migrate — container missing ($name)"
    return
  fi
  local st code
  st="$(container_status "$name")"
  code="$(container_exit_code "$name")"
  case "$st" in
    exited)
      if [ "$code" = "0" ]; then
        ok "migrate — Exited (0)"
      else
        fail "migrate — Exited ($code) — run: $RUNTIME logs $name --tail 40"
      fi
      ;;
    running)
      warn "migrate — still running (migrations in progress?)"
      ;;
    created)
      fail "migrate — Created (never started) — run: ${RUN[*]} up -d migrate"
      ;;
    *)
      fail "migrate — status=$st exit=$code"
      ;;
  esac
}

check_optional() {
  local name="$1" label="$2"
  if ! container_exists "$name"; then
    warn "$label — not present (optional)"
    return
  fi
  local st hp
  st="$(container_status "$name")"
  hp="$(container_health "$name")"
  case "$st" in
    running)
      if [ "$hp" = "healthy" ] || [ "$hp" = "none" ]; then
        ok "$label — Up"
      else
        warn "$label — Up (health=$hp) — optional; core API may still work"
      fi
      ;;
    exited|created|dead|stopped)
      warn "$label — $st — optional; core API may still work"
      ;;
    *)
      warn "$label — status=$st"
      ;;
  esac
}

auth_password_mismatch() {
  container_exists supabase-auth || return 1
  "$RUNTIME" logs supabase-auth 2>&1 | tail -30 | grep -q 'password authentication failed.*supabase_auth_admin'
}

curl_health() {
  local url="$1"
  shift
  curl -fsS --connect-timeout 3 --max-time 5 "$@" "$url" 2>/dev/null
}

echo "TeamClu self-host — health check"
echo "Runtime: $RUNTIME_LABEL"
echo "Env: ${ENV_FILE} (FC_DOMAIN=$FC_DOMAIN, CADDY_HTTP_PORT=$CADDY_HTTP_PORT)"
echo ""

echo "[Critical containers]"
check_running_healthy supabase-db "postgres (supabase-db)"
check_running_healthy supabase-auth "auth (gotrue)"
check_running_healthy supabase-kong "kong (supabase API gateway)"
check_running_healthy supabase-storage "storage"
check_migrate
check_running_healthy teamclaw-self-host_emqx_1 "emqx (MQTT)"
check_running_healthy teamclaw-self-host_fc_1 "fc (Cloud API)"
check_running_healthy teamclaw-self-host_caddy_1 "caddy (reverse proxy)"

echo ""
echo "[HTTP probes]"
FC_URL="http://127.0.0.1:9000/healthz"
CADDY_URL="http://127.0.0.1:${CADDY_HTTP_PORT}/healthz"

if curl_health "$FC_URL" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
  ok "FC direct — $FC_URL → {\"ok\":true}"
else
  st="$(container_status teamclaw-self-host_fc_1 2>/dev/null || echo missing)"
  if [ "$st" = "created" ] || [ "$st" = "missing" ]; then
    fail "FC direct — $FC_URL unreachable (fc not running)"
  else
    fail "FC direct — $FC_URL failed — run: $RUNTIME logs teamclaw-self-host_fc_1 --tail 40"
  fi
fi

if curl_health "$CADDY_URL" -H "Host: ${FC_DOMAIN}" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
  ok "Caddy proxy — $CADDY_URL (Host: $FC_DOMAIN) → {\"ok\":true}"
else
  cst="$(container_status teamclaw-self-host_caddy_1 2>/dev/null || echo missing)"
  if [ "$cst" = "created" ] || [ "$cst" = "missing" ]; then
    warn "Caddy proxy — skipped (caddy not running); Desktop can use FC direct :9000"
  else
    warn "Caddy proxy — $CADDY_URL failed (optional if using :9000 direct)"
  fi
fi

echo ""
echo "[Optional — non-blocking for local dev]"
check_optional supabase-pooler "pooler (supavisor)"
check_optional supabase-analytics "analytics (logflare)"

if [ "$TRY_START" = true ] && [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "[--try-start] recreating fc + caddy (--no-deps)..."
  for svc in fc caddy; do
    "$RUNTIME" rm -f "teamclaw-self-host_${svc}_1" 2>/dev/null || true
    "${RUN[@]}" up -d --no-deps "$svc" 2>&1 || true
  done
  sleep 2
  if curl_health "$FC_URL" | grep -q '"ok"'; then
    echo "  fc started; re-run ./bootstrap/check.sh to refresh full report"
  fi
fi

echo ""
echo "================================"
if [ "$FAIL" -eq 0 ]; then
  echo "Result: OK — core stack is healthy ($WARN optional warning(s))"
  echo ""
  echo "Client dev: packages/app/.env.local → VITE_CLOUD_API_URL=http://127.0.0.1:9000"
  exit 0
fi

echo "Result: FAIL — $FAIL critical issue(s), $WARN optional warning(s)"
echo ""
echo "Suggested fixes:"
if auth_password_mismatch; then
  echo "  • Auth DB password mismatch: POSTGRES_PASSWORD in .env ≠ initialized Postgres."
  echo "    compose down -v does NOT delete supabase/volumes/db/data — run:"
  echo "    ./bootstrap/reset-data.sh"
fi
if container_exists supabase-analytics \
  && "$RUNTIME" logs supabase-analytics 2>&1 | tail -15 | grep -q 'password authentication failed.*supabase_admin'; then
  echo "  • Analytics password mismatch: stale supabase/volumes/db/data bind mount."
  echo "    Run: ./bootstrap/reset-data.sh"
fi
for issue in "${ISSUES[@]}"; do
  case "$issue" in
    *fc*Created*|*fc*never*)
      echo "  • FC stuck Created (Podman): ${RUN[*]} up -d --no-deps fc"
      ;;
    *caddy*Created*|*caddy*never*)
      echo "  • Caddy stuck Created: ${RUN[*]} up -d --no-deps caddy"
      ;;
    *migrate*Created*)
      echo "  • Migrate not run: ${RUN[*]} up -d migrate && $RUNTIME logs -f teamclaw-self-host_migrate_1"
      ;;
  esac
done
echo "  • Full rebuild: ./bootstrap/up.sh"
echo "  • Base stack OK but fc/caddy missing: ./bootstrap/up-app.sh"
echo "  • Auto-start fc/caddy if stuck: ./bootstrap/check.sh --try-start"
echo "  • Logs: $RUNTIME logs <container> --tail 40"
exit 1
