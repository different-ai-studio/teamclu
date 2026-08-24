#!/usr/bin/env python3
"""Mint a long-lived MQTT credential for a StopWatch device.

    # one-time: make a signing secret
    ./tools/mint_device_token.py --gen-secret

    # then, per device
    DEVICE_MQTT_JWT_SECRET=... ./tools/mint_device_token.py \
        --team <team-uuid> --actor <actor-uuid>

The token is pasted into the device's provisioning portal alongside the Wi-Fi
credentials. See main/net/device_token.h for why this exists instead of the
pairing handshake in plan §8.1.

WHY A DEDICATED SECRET, NOT SUPABASE'S
--------------------------------------
EMQX authenticates MQTT by verifying the password as an HS256 JWT. It would be
less work to sign these with the same secret Supabase uses, because EMQX already
trusts it — but then a token leaked off a device would be a *valid Supabase user
token*, usable against the whole API, not just the broker. This repo already
takes that position explicitly: see the comment on `signingKey()` in
services/fc/src/lib/agent-management-grant.ts —

    "Dedicated key only. [...] issuer/audience separation does nothing against
     a holder of the key itself."

So this signs with DEVICE_MQTT_JWT_SECRET, and EMQX gets a *second*
authenticator that trusts only that key. A leaked device token then reaches the
broker and nothing else.

WHAT YOU ARE ACCEPTING
----------------------
The token is long-lived and there is no per-device revocation: revoking means
rotating DEVICE_MQTT_JWT_SECRET, which invalidates every device at once. Fine
for a bench with one device. Not fine for anything shipped — that is what the
full handshake in plan §8.1 is for.
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
import secrets
import sys
import time


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def mint(secret: str, team: str, actor: str, days: int, broker: str) -> str:
    now = int(time.time())
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        # EMQX matches the MQTT username against `sub` in some configurations;
        # keep it equal to the actor so either wiring works.
        "sub": actor,
        "team": team,
        "actor": actor,
        "iss": "teamclu-device",
        # Where to connect. Carried in the token so one pasted string is the
        # device's whole configuration — pointing a device at another
        # environment does not mean rebuilding firmware.
        "broker": broker,
        "iat": now,
        "exp": now + days * 86400,
    }
    signing_input = f"{b64url(json.dumps(header, separators=(',', ':')).encode())}." \
                    f"{b64url(json.dumps(payload, separators=(',', ':')).encode())}"

    # The EMQX authenticator is configured with `secret_base64_encoded = true`,
    # which means EMQX base64-DECODES the configured value and HMACs with the
    # resulting bytes. Signing with the base64 *string* instead produces a token
    # EMQX rejects as `not_authorized` — note: not `bad_username_or_password`,
    # so the log gives no hint that the key is the problem. Decode to match.
    key = base64.b64decode(secret)
    sig = hmac.new(key, signing_input.encode(), hashlib.sha256).digest()
    return f"{signing_input}.{b64url(sig)}"


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gen-secret", action="store_true",
                    help="print a fresh signing secret and the EMQX config to match")
    ap.add_argument("--team", help="team uuid (topic namespace)")
    ap.add_argument("--actor", help="actor uuid (topic namespace)")
    ap.add_argument("--days", type=int, default=365, help="validity, default 365")
    ap.add_argument("--broker", default="mqtt://mqtt.teamclu-dev.ucar.cc:1883",
                    help="broker URI embedded in the token (default: self-host)")
    args = ap.parse_args()

    if args.gen_secret:
        raw = secrets.token_bytes(32)
        secret_b64 = base64.b64encode(raw).decode()
        print("DEVICE_MQTT_JWT_SECRET (base64, 32 bytes):")
        print(f"  {secret_b64}\n")
        print("Add to deploy/self-host/docker-compose.yml — BOTH services, and also")
        print("to services/fc/s.yaml, or it silently goes missing on one deploy target:")
        print(f'  DEVICE_MQTT_JWT_SECRET: "{secret_b64}"\n')
        print("Then give EMQX a SECOND authenticator that trusts only this key,")
        print("alongside the existing Supabase one (env override form):")
        print("  EMQX_AUTHENTICATION__2__MECHANISM: jwt")
        print("  EMQX_AUTHENTICATION__2__USE_JWKS: 'false'")
        print("  EMQX_AUTHENTICATION__2__ALGORITHM: 'hmac-based'")
        print("  EMQX_AUTHENTICATION__2__FROM: password")
        print("  EMQX_AUTHENTICATION__2__SECRET_BASE64_ENCODED: 'true'")
        print(f'  EMQX_AUTHENTICATION__2__SECRET: "{secret_b64}"\n')
        print("⚠ EMQX only reads authenticators at start, and `docker compose up -d`")
        print("  does NOT restart a container just because a bind-mounted file changed.")
        print("  Restart EMQX explicitly or the new authenticator never loads.")
        return 0

    secret = os.environ.get("DEVICE_MQTT_JWT_SECRET", "").strip()
    if not secret:
        print("error: DEVICE_MQTT_JWT_SECRET not set (run --gen-secret first)",
              file=sys.stderr)
        return 1
    if not args.team or not args.actor:
        print("error: --team and --actor are required", file=sys.stderr)
        return 1

    token = mint(secret, args.team, args.actor, args.days, args.broker)
    print(token)
    print(f"\n# team={args.team} actor={args.actor} broker={args.broker} valid={args.days}d",
          file=sys.stderr)
    print("# Paste into the device portal's \"Device token\" field.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
