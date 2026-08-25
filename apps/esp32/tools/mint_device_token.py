#!/usr/bin/env python3
"""Mint an MQTT credential for a StopWatch device.

    JWT_SECRET=... ./tools/mint_device_token.py \
        --team <team-uuid> --actor <actor-uuid>

The token is pasted into the device's provisioning portal alongside the Wi-Fi
credentials. See main/net/device_token.h for why this exists instead of the
pairing handshake in plan §8.1.

WHICH KEY, AND WHAT THAT COSTS
------------------------------
This signs with the deployment's `JWT_SECRET` — the same key Supabase uses,
and the one the broker's single existing authenticator already trusts:

    algorithm = hmac-based, from = password,
    secret_base64_encoded = true, verify_claims = ""

`secret_base64_encoded = true` means EMQX base64-DECODES its configured copy
and HMACs with the resulting bytes. Those bytes are `JWT_SECRET` verbatim, so
that is what this signs with. Signing with a base64 form instead yields a token
EMQX rejects as `not_authorized` — note: NOT `bad_username_or_password`, so
nothing in the log hints that the key is the problem.

An earlier revision of this tool used a dedicated `DEVICE_MQTT_JWT_SECRET` and
a second EMQX authenticator, on the reasoning quoted in
`services/fc/src/lib/agent-management-grant.ts` — a token signed with the main
key is, cryptographically, a valid Supabase token. That is a real cost and it
is being accepted deliberately: the broker keeps ONE authenticator.

What limits the damage is that a device holds a *token*, never the secret, so a
leaked one can only be replayed as-is. These claims are therefore chosen to be
inert against the rest of the stack:

  * NO `role` claim. PostgREST derives the database role from it; without one
    there is no role to assume and no table is reachable.
  * `aud` is `mqtt`, not the `authenticated` audience GoTrue issues.
  * `iss` is `teamclu-device`, so these are identifiable in logs.

Do not add `role`, and do not copy this token shape for anything that talks to
the API.

WHAT YOU ARE ACCEPTING
----------------------
No per-device revocation: revoking means rotating `JWT_SECRET`, which now logs
out every user as well. Fine for a bench with one device; the full handshake in
plan §8.1 is what fixes it.
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
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
        # Deliberately not GoTrue's "authenticated" audience — see the module
        # docstring. There is no `role` claim for the same reason.
        "aud": "mqtt",
        # Where to connect. Carried in the token so one pasted string is the
        # device's whole configuration — pointing a device at another
        # environment does not mean rebuilding firmware.
        "broker": broker,
        "iat": now,
        "exp": now + days * 86400,
    }
    signing_input = f"{b64url(json.dumps(header, separators=(',', ':')).encode())}." \
                    f"{b64url(json.dumps(payload, separators=(',', ':')).encode())}"

    # `JWT_SECRET` verbatim: EMQX already decoded its stored base64 copy back to
    # these same bytes. See the docstring.
    sig = hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).digest()
    return f"{signing_input}.{b64url(sig)}"


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--team", help="team uuid (topic namespace)")
    ap.add_argument("--actor", help="actor uuid (topic namespace)")
    ap.add_argument("--days", type=int, default=365, help="validity, default 365")
    ap.add_argument("--broker", default="mqtt://mqtt.teamclu-dev.ucar.cc:1883",
                    help="broker URI embedded in the token (default: self-host)")
    args = ap.parse_args()

    secret = os.environ.get("JWT_SECRET", "").strip()
    if not secret:
        print("error: JWT_SECRET not set.\n"
              "  It is the deployment's Supabase/EMQX signing key — read it from\n"
              "  the box: deploy/self-host/.env on 47.112.210.217.",
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
