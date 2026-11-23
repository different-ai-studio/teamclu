#!/bin/sh
# Entrypoint for the self-host amuxd daemon.
#
# On first start (no persisted identity yet) it claims a team invite using
# $AMUXD_JOIN_TOKEN, persisting identity under $HOME/.amuxd. Subsequent
# starts reuse the persisted identity and skip the claim.
set -eu

STATE_DIR="${HOME:-/state}/.amuxd"
mkdir -p "$STATE_DIR"

CLOUD_API_URL="${TEAMCLU_CLOUD_API_URL:-http://fc:9000}"
export TEAMCLU_CLOUD_API_URL="$CLOUD_API_URL"

# Has this daemon already been claimed?
#
# The credentials live at `teams/<team_id>/state/backend.toml` (see
# `provider_config.rs`), so the team id is part of the path and this cannot be a
# fixed filename. Home-layout v2 moved the file there; the guard used to check
# `$STATE_DIR/backend.toml`, the v1 location, which nothing writes any more.
# A stale guard does not fail loudly — it re-runs `amuxd init` on *every* start,
# and since an invite is single-use, the second start onwards dies with
# "invite already consumed" and the container crash-loops.
#
# `_unclaimed` is excluded on purpose: it is where an unclaimed daemon's writes
# land, so its presence is not evidence of a claim.
has_identity() {
  for f in "$STATE_DIR"/teams/*/state/backend.toml; do
    [ -f "$f" ] || continue
    case "$f" in
      "$STATE_DIR"/teams/_unclaimed/*) continue ;;
    esac
    return 0
  done
  return 1
}

if ! has_identity; then
  if [ -z "${AMUXD_JOIN_TOKEN:-}" ]; then
    echo "amuxd: no persisted identity and AMUXD_JOIN_TOKEN is empty." >&2
    echo "amuxd: mint a daemon invite (deploy/self-host/amuxd/mint-invite.sh)," >&2
    echo "amuxd: set AMUXD_JOIN_TOKEN in deploy/self-host/.env, then recreate this service." >&2
    exit 1
  fi
  echo "amuxd: claiming team invite against $CLOUD_API_URL ..."
  amuxd init "amux://invite?token=${AMUXD_JOIN_TOKEN}&cloud_api_url=${CLOUD_API_URL}"
  echo "amuxd: invite claimed; identity persisted under $STATE_DIR"
  # A claim that reports success but leaves no credentials would otherwise be
  # discovered one restart later, as a crash loop against a spent invite.
  if ! has_identity; then
    echo "amuxd: claim reported success but no backend.toml was written under" >&2
    echo "amuxd: $STATE_DIR/teams/<team_id>/state/ — refusing to start." >&2
    exit 1
  fi
else
  echo "amuxd: existing identity found in $STATE_DIR; skipping invite claim"
fi

# ── agent runtime ─────────────────────────────────────────────────────────────
# The agent runtime is pi (ADR-0014) on an amuxd-managed Node. Install (or
# repair) it into the state volume; idempotent, so later starts are a no-op.
# A failed install leaves the daemon up (presence + sync still work) and is
# retried on the next start. The LLM is the team AI gateway, which the daemon
# reads from the Cloud API — nothing to configure here.
if ! amuxd install-pi; then
  echo "amuxd: pi runtime install failed; agent sessions will not start until it succeeds" >&2
fi

echo "amuxd: starting daemon ..."
exec amuxd start
