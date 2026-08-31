#!/usr/bin/env bash
#
# deploy-aliyun-fc.sh — Manual, LOCAL deploy of services/fc to a NON-production
# Function Compute function for testing the Alibaba FC deploy path.
#
# ⚠️  This script is intentionally strict:
#       - refuses to deploy to `teamclu-sync` unless explicitly forced
#       - requires an explicit env file (no implicit/stale .env)
#       - prints the target + a confirmation prompt before `s deploy`
#       - does NOT touch the database unless RUN_MIGRATIONS=1
#
# Usage:
#   ./deploy-aliyun-fc.sh <function-name> [env-file]
#
# Examples:
#   ./deploy-aliyun-fc.sh teamclu-api-test                 # uses .env.test.local
#   ./deploy-aliyun-fc.sh teamclu-api-test .env.staging.local
#   RUN_MIGRATIONS=1 ./deploy-aliyun-fc.sh teamclu-api-test   # also migrate
#
# The env file must define (at minimum):
#   ACCESS_KEY_ID, ACCESS_KEY_SECRET   (Aliyun credentials)
#   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
#   PUSH_WEBHOOK_SECRET, APNS_*, MQTT_*   (see .env.test.example)
#
set -euo pipefail

cd "$(dirname "$0")"

FUNCTION_NAME="${1:-}"
ENV_FILE="${2:-.env.test.local}"

if [ -z "$FUNCTION_NAME" ]; then
  echo "ERROR: function name required." >&2
  echo "Usage: ./deploy-aliyun-fc.sh <function-name> [env-file]" >&2
  exit 1
fi

if [ "$FUNCTION_NAME" = "teamclu-sync" ] && [ "${FORCE:-}" != "1" ]; then
  echo "ERROR: refusing to deploy to 'teamclu-sync' without FORCE=1." >&2
  echo "       Set FORCE=1 only when you intend to update the shared function." >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: env file '$ENV_FILE' not found." >&2
  echo "       Copy .env.test.example to '$ENV_FILE' and fill in test values." >&2
  exit 1
fi

# Load the env file (every var becomes an exported process env var, which is
# what Serverless Devs / s.yaml's \${env(...)} reads).
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${ACCESS_KEY_ID:?ACCESS_KEY_ID missing in $ENV_FILE}"
: "${ACCESS_KEY_SECRET:?ACCESS_KEY_SECRET missing in $ENV_FILE}"

# Serverless Devs' ${env('X')} aborts when X is empty OR unset ("not found").
# s.yaml marks several push/MQTT vars as required (no default). For a deploy
# smoke test these don't need real values, so backfill harmless placeholders
# when left blank. (Runtime push/MQTT-auth will be non-functional — expected.)
_backfilled=""
for _v in APNS_PRIVATE_KEY_P8 APNS_KEY_ID APNS_TEAM_ID APNS_TOPIC APNS_ENV \
          MQTT_USERNAME MQTT_PASSWORD; do
  if [ -z "${!_v:-}" ]; then
    printf -v "$_v" '%s' "test-placeholder"
    export "$_v"
    _backfilled="$_backfilled $_v"
  fi
done
[ -n "$_backfilled" ] && echo "NOTE: backfilled empty test vars with placeholders:$_backfilled"

# Account-specific infra ids. s.yaml declares these with no default, so a
# missing one already aborts — but Serverless Devs reports it as a bare
# "env('FC_VPC_ID') not found" after npm install and a full TypeScript build.
# Fail here instead, before any of that work, and say what the value is for.
_missing=""
for _v in FC_VPC_ID FC_SECURITY_GROUP_ID FC_VSWITCH_ID BUCKET; do
  [ -z "${!_v:-}" ] && _missing="$_missing $_v"
done
if [ -n "$_missing" ]; then
  echo "ERROR: missing Alibaba infra id(s) in $ENV_FILE:$_missing" >&2
  echo "" >&2
  echo "       These used to be hardcoded in s.yaml. They name real resources in" >&2
  echo "       one Alibaba account, so there is deliberately no default — an" >&2
  echo "       unset value would deploy into the wrong network or bucket." >&2
  echo "" >&2
  echo "       FC_VPC_ID / FC_SECURITY_GROUP_ID / FC_VSWITCH_ID must match the" >&2
  echo "       network SUPABASE_URL is reachable from; see .env.example." >&2
  exit 1
fi

# MQTT_BROKER_URL is deliberately NOT in the backfill list above, and is checked
# instead. It is the one broker address: FC's own inbox publisher dials it AND
# `GET /v1/config/bootstrap` hands it to clients. An empty one is the single
# worst failure this script can ship — buildMqttConfig() omits the `mqtt` block
# while bootstrap still answers 200, so every client ends up with no broker and
# nothing anywhere logs an error. That is how real-time sync went down for a day
# in issue #634, and how belayo shipped a bootstrap with no broker again after
# the old MQTT_PUBLIC_BROKER_URL override defaulted to "".
#
# It must also be reachable BY CLIENTS — a container-internal address is a
# misconfiguration now that there is no separate public override to correct it.
#
# A placeholder would be worse than nothing here, so refuse instead. Deploys
# that genuinely don't need MQTT (pure smoke tests) opt out explicitly.
if [ -z "${MQTT_BROKER_URL:-}" ] && [ "${ALLOW_EMPTY_MQTT:-}" != "1" ]; then
  echo "ERROR: MQTT_BROKER_URL is empty in $ENV_FILE." >&2
  echo "       This is the broker address delivered to clients. Deploying" >&2
  echo "       without it produces a bootstrap that answers 200 with no \`mqtt\`" >&2
  echo "       block, silently leaving every client with no broker (#634)." >&2
  echo "" >&2
  echo "       Set it to the CLIENT-REACHABLE broker address, e.g." >&2
  echo "         MQTT_BROKER_URL=mqtt://mqtt.example.com:1883" >&2
  echo "" >&2
  echo "       For a smoke test that genuinely does not need MQTT:" >&2
  echo "         ALLOW_EMPTY_MQTT=1 ./deploy-aliyun-fc.sh $FUNCTION_NAME $ENV_FILE" >&2
  exit 1
fi
if [ -z "${MQTT_BROKER_URL:-}" ]; then
  echo "WARN: deploying with an empty MQTT_BROKER_URL (ALLOW_EMPTY_MQTT=1)."
  echo "      Clients will receive no broker from /v1/config/bootstrap."
  # s.yaml declares MQTT_BROKER_URL with no default, so Serverless Devs would
  # abort on a blank. Backfill only on the explicit opt-out path.
  export MQTT_BROKER_URL="test-placeholder"
fi

# Tell s.yaml which function to deploy.
export FC_FUNCTION_NAME="$FUNCTION_NAME"
# Adopt a pre-existing function's http trigger by name (FC console default is
# `defaultTrigger`). Override via FC_HTTP_TRIGGER_NAME=... in the environment.
export FC_HTTP_TRIGGER_NAME="${FC_HTTP_TRIGGER_NAME:-http-trigger}"

echo "────────────────────────────────────────────────────────"
echo "  LOCAL FC deploy (TEST)"
echo "  function : $FUNCTION_NAME"
echo "  region   : ${FC_REGION:-cn-shenzhen}"
echo "  vpc      : ${FC_VPC_ID} / ${FC_VSWITCH_ID}"
echo "  bucket   : ${BUCKET}"
echo "  http trig: $FC_HTTP_TRIGGER_NAME"
echo "  env file : $ENV_FILE"
echo "  supabase : ${SUPABASE_URL:-<unset>}"
# Feature flags served to clients. The durable values ride in the code
# (src/lib/feature-profiles.ts), so unlike MQTT_BROKER_URL an empty override
# here is a completely normal state and NOT worth failing on — adding another
# ALLOW_EMPTY_* gate would only train people to hit `y` without reading.
#
# It is still worth printing: this banner is the only checkpoint before `s
# deploy` rewrites the function's whole environment map. An override shown here
# is being written into that map, and will be gone the next time anyone deploys
# from a machine whose env file lacks it.
if [ -n "${APP_FEATURES_PROFILE:-}" ]; then
  echo "  features : profile=$APP_FEATURES_PROFILE (values in src/lib/feature-profiles.ts)"
else
  echo "  features : <no profile> — clients keep their baked build config."
  echo "             Set APP_FEATURES_PROFILE in $ENV_FILE to serve overrides."
fi
if [ -n "${APP_FEATURES_JSON:-}" ]; then
  echo "  feat-ovr : $APP_FEATURES_JSON"
  echo "             ^ temporary — the NEXT deploy without it will drop it."
else
  echo "  feat-ovr : <none>"
fi
echo "────────────────────────────────────────────────────────"
read -r -p "Deploy '$FUNCTION_NAME' with the above config? [y/N] " ans
case "$ans" in
  y|Y|yes|YES) ;;
  *) echo "Aborted."; exit 0 ;;
esac

# ── Database migrations (OPT-IN) ─────────────────────────────────────────────
# Deploying code and migrating a database are separate decisions with very
# different blast radii, so this script does NOT migrate by default. Merely
# having DATABASE_URL in an env file is not consent to run DDL against it —
# that used to be enough, which meant a routine code deploy silently applied
# every pending migration to whatever database the env file happened to name.
#
# Run migrations yourself, or opt in explicitly with RUN_MIGRATIONS=1.
MIGRATIONS_DIR="$(dirname "$0")/../supabase/migrations"
if [ "${RUN_MIGRATIONS:-}" != "1" ]; then
  echo "==> Skipping database migrations (default)"
  echo "    Migrations are applied by a human, not by this script."
  if [ -n "${DATABASE_URL:-}" ]; then
    echo "    To apply them here instead, re-run with RUN_MIGRATIONS=1."
    echo "    To apply them by hand:"
    echo "      for f in \$(ls $MIGRATIONS_DIR/*.sql | grep -v baseline | sort); do"
    echo "        psql \"\$DATABASE_URL\" -f \"\$f\""
    echo "      done"
  fi
elif [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: RUN_MIGRATIONS=1 but DATABASE_URL is unset in $ENV_FILE." >&2
  exit 1
else
  echo "==> Running database migrations (RUN_MIGRATIONS=1)"
  if ! command -v psql >/dev/null 2>&1; then
    echo "ERROR: psql not found. Install postgresql-client to run migrations." >&2
    exit 1
  fi
  # Migrating is the irreversible half of this script, so make the target
  # explicit and confirm it separately from the deploy prompt above. Redact the
  # credentials — DATABASE_URL carries the password inline.
  echo "    target: $(printf '%s' "$DATABASE_URL" | sed -E 's#://[^@/]*@#://***@#')"
  read -r -p "    Apply pending migrations to this database? [y/N] " mig_ans
  case "$mig_ans" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 0 ;;
  esac
  # Only apply incremental migrations (skip the baseline squash file).
  for migration in $(ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null | grep -v baseline | sort); do
    filename="$(basename "$migration")"
    echo "    applying: $filename"
    psql "$DATABASE_URL" -f "$migration" 2>&1 | grep -v "^$" || true
  done
  echo "    migrations done."
fi

command -v s >/dev/null 2>&1 || npm install -g @serverless-devs/s

echo "==> Configuring Aliyun access (default profile)"
s config add \
  --AccessKeyID "$ACCESS_KEY_ID" \
  --AccessKeySecret "$ACCESS_KEY_SECRET" \
  -a default -f

echo "==> Installing dependencies"
npm install

echo "==> Building TypeScript (-> dist/)"
npm run build

# NOTE: the GitHub Action additionally runs `npm prune --omit=dev` to shrink the
# package. Skipped here so your local node_modules stays intact for dev. The
# extra dev deps in the package are harmless for a test deploy.

echo "==> Deploying $FUNCTION_NAME"
s deploy -y

echo "✅ Done. Deployed function: $FUNCTION_NAME"
