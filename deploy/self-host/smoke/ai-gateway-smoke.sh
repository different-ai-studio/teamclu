#!/bin/sh
# Post-deploy smoke for services/ai-gateway. It is the only AI gateway now --
# both gateways are live until Phase 3.
#
# Reached two ways, on purpose:
#   * in-network, by exec'ing into the container — the gateway publishes NO host
#     port, so curling the host would only
#     ever prove that nothing listens there. It did, the first time this ran.
#   * through Caddy on the public path, which is what clients actually dial and
#     the only check that covers the /ai/* route mapping.
#
# Deliberately spends no upstream tokens: a completion needs a real member JWT,
# which this script cannot mint. What it proves is that the service is up, its
# catalog validated at boot, and the authorization gate is closed. The
# completion path is covered by services/ai-gateway/test/e2e.test.ts.
set -eu

SVC=ai-gateway
fail() { echo "ai-gateway-smoke: FAIL — $1" >&2; exit 1; }

# One exec, all in-network assertions: the image ships node, not curl.
echo "ai-gateway-smoke: in-network checks"
docker compose exec -T "$SVC" node -e '
const B = "http://127.0.0.1:" + (process.env.PORT || 4001);
const T = "00000000-0000-4000-8000-000000000000";
const code = async (p, h) => (await fetch(B + p, { headers: h || {} })).status;
const want = async (p, exp, label, h) => {
  const got = await code(p, h);
  if (got !== exp) { console.error(`  FAIL ${label}: got ${got}, want ${exp}`); process.exit(1); }
  console.log(`  ok  ${label}`);
};
(async () => {
  await want("/healthz", 200, "healthz");
  // A booted gateway has already validated its catalog (missing tier, dangling
  // backend reference, or absent provider key all abort startup), so reaching
  // this point means the catalog is coherent.
  await want(`/v1/teams/${T}/models`, 401, "unauthenticated request rejected");
  await want(`/v1/teams/${T}/models`, 401, "invalid token rejected",
             { Authorization: "Bearer not-a-real-token" });
  // The internal surface must never accept an end-user credential.
  await want("/internal/models", 401, "internal routes gated by the service token",
             { Authorization: "Bearer not-a-real-token" });
  const svc = process.env.AI_GATEWAY_SERVICE_TOKEN;
  if (svc) {
    await want("/internal/models", 200, "internal /models serves the tier catalogue",
               { Authorization: "Bearer " + svc });
  }
})().catch((e) => { console.error("  FAIL", e.message); process.exit(1); });
' || fail "in-network checks"

# Public path. Catches a Caddy /ai/* misroute, which the in-network checks
# cannot see and which would break every client while the service looks fine.
DOMAIN="${FC_DOMAIN:-$(grep '^FC_DOMAIN=' .env 2>/dev/null | cut -d= -f2- || true)}"
if [ -n "$DOMAIN" ]; then
  PUB="https://$DOMAIN/ai/healthz"
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$PUB" || echo 000)
  [ "$c" = "200" ] || fail "public $PUB -> $c (Caddy /ai/* route)"
  echo "  ok  public $PUB -> 200"
else
  echo "  skip public check (FC_DOMAIN unset)"
fi

echo "ai-gateway-smoke: PASS"
