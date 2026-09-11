#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/.env" <<EOF
JWT_SECRET=test-secret-at-least-32-chars-long-xxxxx
POSTGRES_PASSWORD=test-postgres-password
ANON_KEY=
SERVICE_ROLE_KEY=
MQTT_SERVICE_TOKEN=
SUPABASE_DOMAIN=supabase.test
FC_DOMAIN=api.test
CADDY_TLS_MODE=off
EOF
ENV_FILE="$TMP/.env" ./gen-secrets.sh
grep -q '^CADDY_SITE_SCHEME=http://' "$TMP/.env" || { echo "FAIL: CADDY_SITE_SCHEME not http:// for off mode"; exit 1; }
# all three must be non-empty 3-part JWTs
for k in ANON_KEY SERVICE_ROLE_KEY MQTT_SERVICE_TOKEN; do
  v="$(grep "^$k=" "$TMP/.env" | cut -d= -f2-)"
  [ -n "$v" ] || { echo "FAIL: $k empty"; exit 1; }
  [ "$(echo "$v" | awk -F. '{print NF}')" = "3" ] || { echo "FAIL: $k not a JWT"; exit 1; }
done
# signature must verify against JWT_SECRET (decode header.payload, re-sign, compare)
SECRET="test-secret-at-least-32-chars-long-xxxxx"
tok="$(grep '^ANON_KEY=' "$TMP/.env" | cut -d= -f2-)"
data="${tok%.*}"; sig="${tok##*.}"
expected="$(printf '%s' "$data" | openssl dgst -sha256 -hmac "$SECRET" -binary \
  | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
[ "$sig" = "$expected" ] || { echo "FAIL: ANON_KEY signature mismatch"; exit 1; }

# Public ACME sites nested under the on-demand apps wildcard still need their
# own certificate. Caddy 2.10+ otherwise prefers a wildcard certificate which
# this deployment intentionally cannot issue via the HTTP challenge.
sed 's/^CADDY_TLS_MODE=off$/CADDY_TLS_MODE=acme/' "$TMP/.env" > "$TMP/acme.env"
ENV_FILE="$TMP/acme.env" ./gen-secrets.sh
grep -q '^CADDY_SITE_TLS=tls force_automate$' "$TMP/acme.env" || {
  echo "FAIL: CADDY_SITE_TLS does not force ACME automation"
  exit 1
}
echo "PASS"
