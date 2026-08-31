#!/usr/bin/env bash
# Derive ANON_KEY, SERVICE_ROLE_KEY, MQTT_SERVICE_TOKEN from JWT_SECRET.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."
ENV_FILE="${ENV_FILE:-.env}"
[ -f "$ENV_FILE" ] || { echo "error: $ENV_FILE not found" >&2; exit 1; }

JWT_SECRET="$(grep '^JWT_SECRET=' "$ENV_FILE" | cut -d= -f2-)"
[ "${#JWT_SECRET}" -ge 32 ] || { echo "error: JWT_SECRET missing or < 32 chars" >&2; exit 1; }

POSTGRES_PASSWORD="$(grep '^POSTGRES_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)"
[ -n "$POSTGRES_PASSWORD" ] || {
  echo "error: POSTGRES_PASSWORD missing in $ENV_FILE — set a strong password before gen-secrets" >&2
  exit 1
}

"$SCRIPT_DIR/link-volumes.sh"

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
NOW="$(date +%s)"; EXP="$((NOW + 315360000))"  # +10y
mint() { # $1=payload-json
  local header payload data sig
  header="$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)"
  payload="$(printf '%s' "$1" | b64url)"
  data="$header.$payload"
  sig="$(printf '%s' "$data" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | b64url)"
  printf '%s.%s' "$data" "$sig"
}
ANON="$(mint "{\"role\":\"anon\",\"iss\":\"supabase\",\"iat\":$NOW,\"exp\":$EXP}")"
SVC="$(mint "{\"role\":\"service_role\",\"iss\":\"supabase\",\"iat\":$NOW,\"exp\":$EXP}")"
MQTT="$(mint "{\"sub\":\"fc-service\",\"role\":\"service_role\",\"iat\":$NOW,\"exp\":$EXP}")"

set_kv() { # $1=key $2=value — replace in-place (BSD+GNU sed compatible)
  local key="$1" val="$2"
  if grep -q "^$key=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="}
      $1==k{print k"="v; next}{print}' "$ENV_FILE" > "$ENV_FILE.tmp" \
      && mv "$ENV_FILE.tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}
set_kv ANON_KEY "$ANON"
set_kv SERVICE_ROLE_KEY "$SVC"
set_kv MQTT_SERVICE_TOKEN "$MQTT"
EMQX_JWT_SECRET="$(printf '%s' "$JWT_SECRET" | openssl base64 -A)"
set_kv EMQX_JWT_SECRET "$EMQX_JWT_SECRET"

# LiteLLM admin credentials. Random, not derived from JWT_SECRET — the master key
# is a full admin credential for the AI gateway and is handed to FC, not to
# clients. LiteLLM requires the "sk-" prefix. Preserve an existing value so
# re-running gen-secrets.sh does not orphan keys already provisioned in _litellm.
LITELLM_MASTER_KEY="$(grep '^LITELLM_MASTER_KEY=' "$ENV_FILE" | cut -d= -f2- || true)"
if [ -z "$LITELLM_MASTER_KEY" ]; then
  LITELLM_MASTER_KEY="sk-$(openssl rand -hex 24)"
fi
set_kv LITELLM_MASTER_KEY "$LITELLM_MASTER_KEY"

# Shared secret for the AI gateway's /internal/* routes (FC -> gateway). Never
# handed to a client. Preserved across runs like the key above, so re-running
# this script does not lock FC out of a gateway that is already deployed.
AI_GATEWAY_SERVICE_TOKEN="$(grep '^AI_GATEWAY_SERVICE_TOKEN=' "$ENV_FILE" | cut -d= -f2- || true)"
if [ -z "$AI_GATEWAY_SERVICE_TOKEN" ]; then
  AI_GATEWAY_SERVICE_TOKEN="$(openssl rand -hex 32)"
fi
set_kv AI_GATEWAY_SERVICE_TOKEN "$AI_GATEWAY_SERVICE_TOKEN"

LITELLM_UI_PASSWORD="$(grep '^LITELLM_UI_PASSWORD=' "$ENV_FILE" | cut -d= -f2- || true)"
if [ -z "$LITELLM_UI_PASSWORD" ]; then
  set_kv LITELLM_UI_PASSWORD "$(openssl rand -hex 16)"
fi

CADDY_TLS_MODE="$(grep '^CADDY_TLS_MODE=' "$ENV_FILE" | cut -d= -f2- || true)"
case "${CADDY_TLS_MODE:-acme}" in
  internal) CADDY_GLOBAL_TLS=""; CADDY_SITE_TLS="tls internal"; CADDY_SITE_SCHEME="" ;;
  off)      CADDY_GLOBAL_TLS="auto_https off"; CADDY_SITE_TLS=""; CADDY_SITE_SCHEME="http://" ;;
  *)        CADDY_GLOBAL_TLS=""; CADDY_SITE_TLS=""; CADDY_SITE_SCHEME="" ;;   # acme default
esac
set_kv CADDY_GLOBAL_TLS "$CADDY_GLOBAL_TLS"
set_kv CADDY_SITE_TLS "$CADDY_SITE_TLS"
set_kv CADDY_SITE_SCHEME "$CADDY_SITE_SCHEME"

# Derive URL vars from domain settings so Supabase compose gets resolved values.
SUPABASE_DOMAIN="$(grep '^SUPABASE_DOMAIN=' "$ENV_FILE" | cut -d= -f2-)"
FC_DOMAIN="$(grep '^FC_DOMAIN=' "$ENV_FILE" | cut -d= -f2-)"
[ -n "$SUPABASE_DOMAIN" ] || { echo "error: SUPABASE_DOMAIN not set in $ENV_FILE" >&2; exit 1; }
[ -n "$FC_DOMAIN" ] || { echo "error: FC_DOMAIN not set in $ENV_FILE" >&2; exit 1; }
URL_SCHEME="https"
[ "${CADDY_TLS_MODE:-acme}" = "off" ] && URL_SCHEME="http"
set_kv SUPABASE_PUBLIC_URL "${URL_SCHEME}://${SUPABASE_DOMAIN}"
set_kv API_EXTERNAL_URL "${URL_SCHEME}://${SUPABASE_DOMAIN}"
set_kv SITE_URL "${URL_SCHEME}://${FC_DOMAIN}"

echo "gen-secrets: wrote ANON_KEY, SERVICE_ROLE_KEY, MQTT_SERVICE_TOKEN, EMQX_JWT_SECRET, LITELLM_MASTER_KEY, LITELLM_UI_PASSWORD, CADDY_GLOBAL_TLS, CADDY_SITE_TLS, CADDY_SITE_SCHEME, SUPABASE_PUBLIC_URL, API_EXTERNAL_URL, SITE_URL to $ENV_FILE"
