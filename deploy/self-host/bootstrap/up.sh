#!/usr/bin/env bash
# Bring up the self-host stack. Handles podman-compose quirks automatically.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${ENV_FILE:-.env}"
[ -f "$ENV_FILE" ] || { echo "error: $ENV_FILE not found — cp .env.example .env first" >&2; exit 1; }

"$ROOT/bootstrap/link-volumes.sh"

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
  export CADDY_HTTP_PORT="${CADDY_HTTP_PORT:-8080}"
  export CADDY_HTTPS_PORT="${CADDY_HTTPS_PORT:-8443}"
  RUN=( podman-compose --in-pod false "${COMPOSE[@]}" )
  echo "up: using podman-compose (--in-pod false + docker-compose.podman.yml)"
  echo "up: caddy on host ports ${CADDY_HTTP_PORT}/${CADDY_HTTPS_PORT} (rootless podman cannot bind 80/443)"
elif command -v docker >/dev/null 2>&1; then
  COMPOSE=( -f docker-compose.yml )
  RUNTIME=docker
  RUN=( docker compose "${COMPOSE[@]}" )
  echo "up: using docker compose"
else
  echo "error: need docker compose or podman-compose on PATH" >&2
  exit 1
fi

fc_container() {
  echo "teamclaw-self-host_fc_1"
}

caddy_container() {
  echo "teamclaw-self-host_caddy_1"
}

migrate_container() {
  echo "teamclaw-self-host_migrate_1"
}

wait_fc() {
  local max="${1:-120}" i=0 name
  name="$(fc_container)"
  while [ "$i" -lt "$max" ]; do
    if "$RUNTIME" exec "$name" node -e \
      "fetch('http://127.0.0.1:9000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
      2>/dev/null; then
      return 0
    fi
    if curl -fsS --connect-timeout 2 --max-time 3 http://127.0.0.1:9000/healthz >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
    i=$((i + 3))
  done
  echo "error: fc /healthz not ready after ${max}s" >&2
  "$RUNTIME" logs "$name" 2>&1 | tail -20 >&2 || true
  return 1
}

wait_healthy() { # $1=container name, $2=max seconds
  local name="$1" max="${2:-120}" i=0
  echo "up: waiting for $name (healthcheck, up to ${max}s)..."
  while [ "$i" -lt "$max" ]; do
    if "$RUNTIME" inspect "$name" --format '{{.State.Health.Status}}' 2>/dev/null | grep -qx healthy; then
      echo "up: $name is healthy"
      return 0
    fi
    if "$RUNTIME" inspect "$name" --format '{{.State.Running}}' 2>/dev/null | grep -qx true \
      && ! "$RUNTIME" inspect "$name" --format '{{.State.Healthcheck}}' 2>/dev/null | grep -q Healthcheck; then
      echo "up: $name is up (no healthcheck)"
      return 0
    fi
    if [ "$name" = "supabase-auth" ] \
      && "$RUNTIME" logs supabase-auth 2>&1 | tail -10 | grep -q 'password authentication failed.*supabase_auth_admin'; then
      echo "error: supabase-auth cannot connect — POSTGRES_PASSWORD in .env does not match" >&2
      echo "       the initialized Postgres data under supabase/volumes/db/data." >&2
      echo "       Run: ./bootstrap/reset-data.sh" >&2
      return 1
    fi
    if [ "$name" = "supabase-analytics" ] \
      && "$RUNTIME" logs supabase-analytics 2>&1 | tail -15 | grep -q 'password authentication failed.*supabase_admin'; then
      echo "error: supabase-analytics cannot connect — stale Postgres bind mount." >&2
      echo "       Run: ./bootstrap/reset-data.sh (must delete supabase/volumes/db/data)" >&2
      return 1
    fi
    printf 'up:   %s (%ds/%ds)\n' "$name" "$i" "$max"
    sleep 3
    i=$((i + 3))
  done
  echo "error: $name not healthy after ${max}s" >&2
  "$RUNTIME" logs "$name" 2>&1 | tail -20 >&2 || true
  return 1
}

wait_exit_ok() { # $1=container name, $2=max seconds
  local name="$1" max="${2:-300}" i=0
  while [ "$i" -lt "$max" ]; do
    local status
    status="$("$RUNTIME" inspect "$name" --format '{{.State.Status}}' 2>/dev/null || echo missing)"
    case "$status" in
      exited)
        local code
        code="$("$RUNTIME" inspect "$name" --format '{{.State.ExitCode}}')"
        [ "$code" = "0" ] && return 0
        echo "error: $name exited with code $code" >&2
        "$RUNTIME" logs "$name" 2>&1 | tail -30 >&2
        return 1
        ;;
      running) sleep 2; i=$((i + 2)) ;;
      created|missing)
        sleep 2
        i=$((i + 2))
        ;;
      *) sleep 2; i=$((i + 2)) ;;
    esac
  done
  echo "error: $name did not finish within ${max}s" >&2
  return 1
}

compose_services_except() {
  local exclude_re="$1"
  "${RUN[@]}" config --services 2>/dev/null | grep -vxE "$exclude_re" || true
}

recreate_no_deps() { # $1=service name
  local svc="$1" cname="teamclaw-self-host_${svc}_1"
  echo "up: recreate $svc (--no-deps, clears stale podman dependency edges)"
  "$RUNTIME" rm -f "$cname" 2>/dev/null || true
  "${RUN[@]}" up -d --no-deps --build "$svc"
}

if use_podman_compose; then
  echo "==> compose down (clean stale podman dependency graph)"
  "${RUN[@]}" down --remove-orphans 2>/dev/null || true
  podman pod rm -f pod_teamclaw-self-host 2>/dev/null || true
  podman rm -f $(podman ps -aq --filter label=com.docker.compose.project=teamclaw-self-host) 2>/dev/null || true

  echo "==> compose up (base stack, excluding fc/caddy — may take several minutes on first boot)"
  BASE_SERVICES="$(compose_services_except '^(fc|caddy)$' | tr '\n' ' ')"
  BASE_SERVICES="${BASE_SERVICES%% }"
  if [ -z "$BASE_SERVICES" ]; then
    echo "error: no compose services found" >&2
    exit 1
  fi
  # shellcheck disable=SC2086
  "${RUN[@]}" up -d --build $BASE_SERVICES
else
  echo "==> compose up (full stack)"
  "${RUN[@]}" up -d --build
fi

echo "==> wait for supabase-db"
wait_healthy supabase-db 180

echo "==> wait for supabase-auth + supabase-storage"
wait_healthy supabase-auth 120
wait_healthy supabase-storage 180

MIGRATE="$(migrate_container)"
if use_podman_compose; then
  echo "==> run migrate"
  "$RUNTIME" start "$MIGRATE" 2>/dev/null \
    || "${RUN[@]}" up -d --no-deps migrate 2>/dev/null \
    || true
fi
wait_exit_ok "$MIGRATE" 300

if use_podman_compose; then
  recreate_no_deps fc
else
  echo "==> ensure fc is up"
  "${RUN[@]}" up -d fc 2>/dev/null || true
fi
wait_fc 120

if use_podman_compose; then
  recreate_no_deps caddy
else
  echo "==> ensure caddy is up"
  if ! "$RUNTIME" start "$(caddy_container)" 2>/dev/null; then
    "${RUN[@]}" up -d --no-deps caddy 2>/dev/null || true
  fi
fi

echo "==> status"
"${RUN[@]}" ps

echo "up: done — run ./bootstrap/check.sh to verify"
