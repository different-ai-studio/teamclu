#!/usr/bin/env bash
# One-shot bootstrap for amuxd on the self-host ECS box.
#
# - Mints a daemon invite when AMUXD_JOIN_TOKEN is empty and no identity exists
# - Writes AMUXD_JOIN_TOKEN (+ optional AMUXD_TEAM_ID) into deploy/self-host/.env
# - Drops the legacy OPENCODE_* keys (the opencode runtime is gone, ADR-0014)
#
# The file name predates pi: agent sessions now run whenever the team has an AI
# gateway, so "presence-only" no longer describes the result.
#
# Usage (on ECS, from deploy/self-host/):
#   ./amuxd/bootstrap-presence-only.sh [TEAM_ID]
#
# After this, trigger the Daemon Deploy workflow (or pull the GHCR image manually).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[ -f .env ] || { echo "bootstrap: $ROOT/.env not found"; exit 1; }

TEAM_ID="${1:-${TEAM_ID:-}}"
STATE_VOLUME="${COMPOSE_PROJECT_NAME:-teamclaw-self-host}_amuxd_state"

upsert_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env; then
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next}{print}' .env > .env.tmp && mv .env.tmp .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
  echo "  set $key"
}

clear_env() {
  local key="$1"
  if grep -q "^${key}=" .env; then
    grep -v "^${key}=" .env > .env.tmp && mv .env.tmp .env
    echo "  cleared $key"
  fi
}

has_identity() {
  docker volume inspect "$STATE_VOLUME" >/dev/null 2>&1 \
    && docker run --rm -v "${STATE_VOLUME}:/state" alpine:3.20 \
         test -f /state/.amuxd/backend.toml
}

echo "=== amuxd bootstrap ==="

if has_identity; then
  echo "  existing amuxd identity in volume $STATE_VOLUME — skip invite mint"
else
  token_line="$(./amuxd/mint-invite.sh ${TEAM_ID:+"$TEAM_ID"})"
  token="$(printf '%s\n' "$token_line" | sed -n 's/^AMUXD_JOIN_TOKEN=//p')"
  [ -n "$token" ] || { echo "bootstrap: mint-invite did not return a token"; exit 1; }
  upsert_env AMUXD_JOIN_TOKEN "$token"
fi

if [ -n "$TEAM_ID" ]; then
  upsert_env AMUXD_TEAM_ID "$TEAM_ID"
fi

for key in OPENCODE_BASE_URL OPENCODE_API_KEY OPENCODE_MODEL OPENCODE_PROVIDER_ID OPENCODE_PROVIDER_NAME; do
  clear_env "$key"
done

echo "=== done ==="
echo "Next: trigger .github/workflows/daemon-deploy.yml (or docker compose pull/up amuxd)."
