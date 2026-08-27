#!/usr/bin/env bash
# Idempotent first-run setup for the bundled Gitea instance:
#   admin user → org (GITEA_OWNER) → bot user → org membership → API token
#
# The container ships already-configured: compose sets INSTALL_LOCK=true and the
# sqlite DB_TYPE, so there is no install step to drive here. Gitea exposes no
# install REST route — the first admin is made with the in-container CLI.
#
# Run from deploy/self-host after `docker compose up -d gitea` (or full stack):
#   ./init/gitea-bootstrap.sh
#
# Reads deploy/self-host/.env (override with ENV_FILE=). Requires:
#   GITEA_OWNER, GITEA_ADMIN_* , GITEA_BOT_* passwords on a fresh volume.
# Prints GITEA_TOKEN=… when it mints a new token — paste into .env, then
#   docker compose up -d fc
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${ENV_FILE:-.env}"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a && source "$ENV_FILE" && set +a
fi

# Compose v2 names containers with hyphens (`<project>-<service>-<n>`); the
# underscore form is v1. run-e2e.sh inspects `teamclaw-self-host-fc-1`, so v2 is
# what the box runs. Probe both rather than hard-coding one — getting this wrong
# silently fell back to curling the host, where port 3000 is not published, and
# the script then reported "is the container running?" about a running container.
detect_gitea_container() {
  if [ -n "${GITEA_CONTAINER:-}" ]; then
    echo "$GITEA_CONTAINER"
    return
  fi
  local candidate
  for candidate in teamclaw-self-host-gitea-1 teamclaw-self-host_gitea_1; do
    if docker inspect "$candidate" >/dev/null 2>&1; then
      echo "$candidate"
      return
    fi
  done
  echo "teamclaw-self-host-gitea-1"
}
GITEA_CONTAINER="$(detect_gitea_container)"
GITEA_INTERNAL_URL="${GITEA_INTERNAL_URL:-http://127.0.0.1:3000}"
GITEA_OWNER="${GITEA_OWNER:-teamclaw-apps}"
GITEA_ADMIN_USERNAME="${GITEA_ADMIN_USERNAME:-gitea-admin}"
GITEA_ADMIN_PASSWORD="${GITEA_ADMIN_PASSWORD:-}"
GITEA_ADMIN_EMAIL="${GITEA_ADMIN_EMAIL:-ops@example.com}"
GITEA_BOT_USERNAME="${GITEA_BOT_USERNAME:-teamclu-bot}"
GITEA_BOT_PASSWORD="${GITEA_BOT_PASSWORD:-}"
# Gitea validates this: `user@localhost` is rejected with a bare
# `422 {"message":"[Email]: Email"}`, so the bot's address has to carry a real
# domain. Default to the admin's domain rather than adding another required
# variable — an operator who set GITEA_ADMIN_EMAIL has already supplied one.
GITEA_BOT_EMAIL="${GITEA_BOT_EMAIL:-${GITEA_BOT_USERNAME}@${GITEA_ADMIN_EMAIL#*@}}"
GITEA_TOKEN="${GITEA_TOKEN:-}"
TOKEN_NAME="${GITEA_TOKEN_NAME:-teamclu-fc}"

use_podman_compose() {
  command -v podman-compose >/dev/null || return 1
  if ! command -v docker >/dev/null 2>&1; then
    return 0
  fi
  docker compose version 2>&1 | grep -q podman-compose
}

if use_podman_compose; then
  COMPOSE=( podman-compose --in-pod false -f docker-compose.yml -f docker-compose.podman.yml )
else
  COMPOSE=( docker compose -f docker-compose.yml )
fi

gitea_curl() {
  # Prefer exec into the running container — works before fc/caddy are up and
  # needs no published HTTP port on the host.
  #
  # `--fail-with-body` rather than `-f`: Gitea explains its 4xx in the response
  # body (`{"message":"[Email]: Email"}`), and plain `-f` discards it, leaving
  # only `curl: (22) ... error: 422` to debug from.
  if docker inspect "$GITEA_CONTAINER" >/dev/null 2>&1; then
    docker exec -i "$GITEA_CONTAINER" curl -sS --fail-with-body "$@"
  else
    curl -sS --fail-with-body "$@"
  fi
}

gitea_http_code() {
  if docker inspect "$GITEA_CONTAINER" >/dev/null 2>&1; then
    docker exec -i "$GITEA_CONTAINER" curl -s -o /dev/null -w '%{http_code}' "$@"
  else
    curl -s -o /dev/null -w '%{http_code}' "$@"
  fi
}

wait_for_gitea() {
  echo "gitea-bootstrap: waiting for Gitea API…" >&2
  for i in $(seq 1 60); do
    if code="$(gitea_http_code "${GITEA_INTERNAL_URL}/api/healthz" 2>/dev/null || true)"; then
      :
    fi
    if [ "${code:-}" = "200" ]; then
      echo "gitea-bootstrap: Gitea is up" >&2
      return 0
    fi
    sleep 2
  done
  echo "gitea-bootstrap: Gitea did not become healthy — is the container running?" >&2
  echo "  ${COMPOSE[*]} up -d gitea" >&2
  exit 1
}

gitea_cli() {
  docker exec -i -u git "$GITEA_CONTAINER" gitea "$@"
}

# The first admin, created with the CLI.
#
# Gitea has no install REST endpoint — first-run setup is a web form. The
# container instead ships configured (compose sets INSTALL_LOCK=true and the
# sqlite DB_TYPE), and the admin is made with `gitea admin user create`. Driving
# the wizard over HTTP, as an earlier revision tried, 404s on the first call and
# aborts the script under `set -e`.
ensure_admin_user() {
  if gitea_cli admin user list 2>/dev/null | awk 'NR>1 {print $2}' \
      | grep -qx "$GITEA_ADMIN_USERNAME"; then
    echo "gitea-bootstrap: admin ${GITEA_ADMIN_USERNAME} already exists" >&2
    return 0
  fi
  if [ -z "$GITEA_ADMIN_PASSWORD" ]; then
    echo "gitea-bootstrap: GITEA_ADMIN_PASSWORD is required to create the first admin" >&2
    exit 1
  fi
  echo "gitea-bootstrap: creating admin ${GITEA_ADMIN_USERNAME}…" >&2
  gitea_cli admin user create \
    --username "$GITEA_ADMIN_USERNAME" \
    --password "$GITEA_ADMIN_PASSWORD" \
    --email "$GITEA_ADMIN_EMAIL" \
    --admin --must-change-password=false
}

admin_auth=( -u "${GITEA_ADMIN_USERNAME}:${GITEA_ADMIN_PASSWORD}" )

ensure_org() {
  if gitea_curl "${admin_auth[@]}" "${GITEA_INTERNAL_URL}/api/v1/orgs/${GITEA_OWNER}" >/dev/null 2>&1; then
    echo "gitea-bootstrap: org ${GITEA_OWNER} already exists" >&2
    return 0
  fi
  echo "gitea-bootstrap: creating org ${GITEA_OWNER}…" >&2
  gitea_curl "${admin_auth[@]}" -X POST "${GITEA_INTERNAL_URL}/api/v1/orgs" \
    -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg org "$GITEA_OWNER" '{username: $org, visibility: "private"}')"
}

ensure_bot_user() {
  if gitea_curl "${admin_auth[@]}" "${GITEA_INTERNAL_URL}/api/v1/users/${GITEA_BOT_USERNAME}" >/dev/null 2>&1; then
    echo "gitea-bootstrap: bot user ${GITEA_BOT_USERNAME} already exists" >&2
    return 0
  fi
  if [ -z "$GITEA_BOT_PASSWORD" ]; then
    echo "gitea-bootstrap: GITEA_BOT_PASSWORD is required to create the bot user" >&2
    exit 1
  fi
  echo "gitea-bootstrap: creating bot user ${GITEA_BOT_USERNAME}…" >&2
  gitea_curl "${admin_auth[@]}" -X POST "${GITEA_INTERNAL_URL}/api/v1/admin/users" \
    -H 'Content-Type: application/json' \
    -d "$(jq -nc \
      --arg user "$GITEA_BOT_USERNAME" \
      --arg pass "$GITEA_BOT_PASSWORD" \
      --arg email "$GITEA_BOT_EMAIL" \
      '{
        username: $user,
        email: $email,
        password: $pass,
        must_change_password: false,
        send_notify: false
      }')"
}

ensure_bot_in_org() {
  # Owners team membership lets the bot create repos under the org.
  if gitea_curl "${admin_auth[@]}" \
    "${GITEA_INTERNAL_URL}/api/v1/orgs/${GITEA_OWNER}/members/${GITEA_BOT_USERNAME}" \
    >/dev/null 2>&1; then
    echo "gitea-bootstrap: ${GITEA_BOT_USERNAME} is already in org ${GITEA_OWNER}" >&2
    return 0
  fi
  # Membership is keyed by NUMERIC team id: PUT /teams/{id}/members/{username}.
  # There is no /orgs/{org}/teams/{name}/members route — using one 404s and, under
  # `set -e` with `curl -fsS`, takes the whole script down.
  local team_id
  team_id="$(gitea_curl "${admin_auth[@]}" \
    "${GITEA_INTERNAL_URL}/api/v1/orgs/${GITEA_OWNER}/teams" \
    | jq -r '.[] | select(.name == "Owners") | .id' | head -n1)"
  if [ -z "$team_id" ] || [ "$team_id" = "null" ]; then
    echo "gitea-bootstrap: could not resolve the Owners team id for ${GITEA_OWNER}" >&2
    exit 1
  fi
  echo "gitea-bootstrap: adding ${GITEA_BOT_USERNAME} to org ${GITEA_OWNER} (team ${team_id})…" >&2
  gitea_curl "${admin_auth[@]}" -X PUT \
    "${GITEA_INTERNAL_URL}/api/v1/teams/${team_id}/members/${GITEA_BOT_USERNAME}"
}

verify_existing_token() {
  [ -n "$GITEA_TOKEN" ] || return 1
  if gitea_curl -H "Authorization: token ${GITEA_TOKEN}" \
    "${GITEA_INTERNAL_URL}/api/v1/user" >/dev/null 2>&1; then
    echo "gitea-bootstrap: GITEA_TOKEN in .env is valid — nothing to mint" >&2
    return 0
  fi
  echo "gitea-bootstrap: GITEA_TOKEN in .env failed auth — minting a new token" >&2
  return 1
}

mint_bot_token() {
  if verify_existing_token; then
    return 0
  fi
  if [ -z "$GITEA_BOT_PASSWORD" ]; then
    echo "gitea-bootstrap: GITEA_BOT_PASSWORD is required to mint the bot token" >&2
    exit 1
  fi
  echo "gitea-bootstrap: creating API token ${TOKEN_NAME} for ${GITEA_BOT_USERNAME}…" >&2
  # Basic-auth AS THE BOT: /users/{username}/tokens mints for the authenticated
  # user, so admin credentials here would mint an admin token (or be rejected).
  # `scopes` is required since Gitea 1.20 — omit it and the token can do nothing,
  # which surfaces much later as a 403 on createAppRepo.
  resp="$(gitea_curl -u "${GITEA_BOT_USERNAME}:${GITEA_BOT_PASSWORD}" -X POST \
    "${GITEA_INTERNAL_URL}/api/v1/users/${GITEA_BOT_USERNAME}/tokens" \
    -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg name "$TOKEN_NAME" \
      '{name: $name, scopes: ["write:repository", "write:organization", "read:user"]}')")"
  token="$(echo "$resp" | jq -r '.sha1 // empty')"
  if [ -z "$token" ]; then
    echo "gitea-bootstrap: token creation failed: $resp" >&2
    exit 1
  fi
  echo >&2
  echo "GITEA_TOKEN=$token"
  echo >&2
  echo "Add the line above to ${ENV_FILE}, then restart fc:" >&2
  echo "  ${COMPOSE[*]} up -d fc" >&2
}

main() {
  command -v jq >/dev/null || { echo "gitea-bootstrap: jq is required" >&2; exit 1; }

  if ! docker inspect "$GITEA_CONTAINER" >/dev/null 2>&1; then
    echo "gitea-bootstrap: starting gitea container…" >&2
    "${COMPOSE[@]}" up -d gitea
  fi

  wait_for_gitea

  if [ -z "$GITEA_ADMIN_PASSWORD" ]; then
    echo "gitea-bootstrap: GITEA_ADMIN_PASSWORD is required for org/bot setup" >&2
    exit 1
  fi
  ensure_admin_user

  ensure_org
  ensure_bot_user
  ensure_bot_in_org
  mint_bot_token

  echo "gitea-bootstrap: done" >&2
}

main "$@"
