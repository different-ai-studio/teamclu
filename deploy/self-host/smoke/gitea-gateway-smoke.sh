#!/usr/bin/env sh
# The Gitea gateway must be the only way to name a Gitea user.
#
# Gitea trusts X-WEBAUTH-USER from anyone who can reach its HTTP port, so the
# per-account git auth is exactly as safe as the claims checked here
# (docs/specs/2026-11-16-app-platform-identity-design.md §6, §10):
#
#   1    the web UI is 404
#   2    the API is 404 except the PR routes, which need a credential (401)
#   3    a git request with no credential is 401 and asks git for one
#   4    a forged X-WEBAUTH-USER is ignored
#   5    a real Gitea password/token is not accepted (Authorization is stripped)
#   6    containers other than Caddy cannot reach gitea:3000
#   7    Caddy's internal :8081 entrance strips X-WEBAUTH-USER
#
# Usage (from deploy/self-host/, on the box): sh smoke/gitea-gateway-smoke.sh
# GITEA_GATEWAY_URL overrides the public URL; SKIP_CONTAINER_CHECKS=1 skips 6-7
# (for running 1-5 against a local gateway). Exits non-zero on any failure.
set -eu

ENV_FILE="${ENV_FILE:-.env}"
# Read only the keys used here, never `.` the file: compose's .env is not shell
# (`CADDY_GLOBAL_TLS=auto_https off`, `STUDIO_DEFAULT_ORGANIZATION=Default
# Organization`), and sourcing it runs the word after the space as a command.
# A value already in the environment wins, as it would with compose.
env_value() { # $1=key → last `key=value` in ENV_FILE, quotes stripped
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}
for key in GITEA_PUBLIC_URL GITEA_DOMAIN GITEA_BOT_USERNAME GITEA_OWNER GITEA_TOKEN; do
  eval "current=\${$key:-}"
  if [ -z "$current" ]; then
    value=$(env_value "$key")
    [ -z "$value" ] || export "$key=$value"
  fi
done

BASE="${GITEA_GATEWAY_URL:-${GITEA_PUBLIC_URL:-}}"
if [ -z "$BASE" ] && [ -n "${GITEA_DOMAIN:-}" ]; then BASE="https://${GITEA_DOMAIN}"; fi
if [ -z "$BASE" ]; then
  echo "gitea-gateway-smoke: no GITEA_DOMAIN — nothing to check"
  exit 0
fi
BASE="${BASE%/}"
FC_CONTAINER="${FC_CONTAINER:-teamclaw-self-host-fc-1}"
BOT="${GITEA_BOT_USERNAME:-teamclu-bot}"
REPO_PATH="/${GITEA_OWNER:-teamclaw-apps}/smoke-probe.git/info/refs?service=git-upload-pack"

failures=0
ok()   { echo "  ok   $1"; }
bad()  { echo "  FAIL $1"; failures=$((failures + 1)); }
code() { curl -s -o /dev/null -w '%{http_code}' -m 10 "$@" || echo "000"; }

echo "=== gitea gateway ($BASE) ==="

c=$(code "$BASE/")
[ "$c" = "404" ] && ok "web UI is closed (/ -> $c)" || bad "web UI answered $c, want 404"

# The API is closed except the few PR routes Caddy hands to FC (@prapi /
# @prread, #1884): those need a credential, so an anonymous call is FC's 401
# challenge, and everything else in the API is still a 404.
hdr=$(curl -s -D - -o /dev/null -m 10 "$BASE/api/v1/version" || true)
c=$(printf '%s' "$hdr" | awk 'NR==1{print $2}')
if [ "$c" = "401" ] && printf '%s' "$hdr" | grep -qi '^www-authenticate: *basic'; then
  ok "PR API without a credential -> 401 with WWW-Authenticate (/api/v1/version)"
else
  bad "PR API without a credential answered $c (or no WWW-Authenticate), want 401 + Basic challenge"
fi

c=$(code "$BASE/api/v1/settings/api")
[ "$c" = "404" ] && ok "rest of the API is closed (/api/v1/settings/api -> $c)" || bad "API answered $c, want 404"

hdr=$(curl -s -D - -o /dev/null -m 10 "$BASE$REPO_PATH" || true)
c=$(printf '%s' "$hdr" | awk 'NR==1{print $2}')
if [ "$c" = "401" ] && printf '%s' "$hdr" | grep -qi '^www-authenticate: *basic'; then
  ok "git without a credential -> 401 with WWW-Authenticate"
else
  bad "git without a credential answered $c (or no WWW-Authenticate), want 401 + Basic challenge"
fi

c=$(code -H "X-WEBAUTH-USER: $BOT" "$BASE$REPO_PATH")
[ "$c" = "401" ] && ok "forged X-WEBAUTH-USER is ignored ($c)" || bad "forged X-WEBAUTH-USER answered $c, want 401"

if [ -n "${GITEA_TOKEN:-}" ]; then
  c=$(code -u "$BOT:$GITEA_TOKEN" "$BASE$REPO_PATH")
  [ "$c" = "401" ] && ok "a Gitea token does not get through the gateway ($c)" || bad "a Gitea token answered $c, want 401"
else
  echo "  skip a Gitea token does not get through (no GITEA_TOKEN)"
fi

if [ "${SKIP_CONTAINER_CHECKS:-}" != "1" ]; then
  # Node is in the fc image; curl is not guaranteed to be.
  if docker exec "$FC_CONTAINER" node -e "fetch('http://gitea:3000/api/healthz',{signal:AbortSignal.timeout(5000)}).then(()=>process.exit(1),()=>process.exit(0))" 2>/dev/null; then
    ok "fc cannot reach gitea:3000"
  else
    bad "fc reached gitea:3000 directly — Gitea is not isolated"
  fi
  c=$(docker exec "$FC_CONTAINER" node -e "fetch('http://caddy:8081/api/v1/user',{headers:{'X-WEBAUTH-USER':'$BOT'},signal:AbortSignal.timeout(5000)}).then(r=>{console.log(r.status)},()=>console.log('000'))" 2>/dev/null || echo "000")
  [ "$c" = "401" ] && ok "caddy:8081 strips X-WEBAUTH-USER ($c)" || bad "caddy:8081 with a forged user answered $c, want 401"
fi

if [ "$failures" -gt 0 ]; then
  echo "gitea-gateway-smoke: $failures check(s) failed"
  exit 1
fi
echo "gitea-gateway-smoke: all checks passed"
