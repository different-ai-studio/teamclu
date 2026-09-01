# TeamClu Self-host All-in-one

A single Docker image that folds the full TeamClu self-host backend into one
auto-starting container, behind Caddy on one port (`8080`).

It runs a real Supabase data plane (Postgres + GoTrue + PostgREST +
storage-api) plus NanoMQ, the TeamClu Cloud API (FC), and Caddy — all under
`supervisord`.

## What runs inside

| Service | Port (internal) | Notes |
| --- | --- | --- |
| Postgres | 5432 | supabase/postgres base image (roles, `auth`, extensions) |
| GoTrue (auth) | 9999 | `/auth/v1/*` |
| PostgREST | 3000 | `/rest/v1/*`, schemas `public,storage,graphql_public,amux` |
| storage-api | 5000 | `/storage/v1/*`, file backend at `/data/storage` |
| NanoMQ | 1883 / 8083 | MQTT + MQTT-over-WS `/mqtt`; JWT CONNECT auth hook |
| mqtt-auth | 9091 | JWT validator for NanoMQ's HTTP auth hook |
| FC (Cloud API) | 9000 | `/v1/*`, `/api/*` |
| Caddy | 8080 | the only public listener (layer4 split: HTTP + raw MQTT) |
| health responder | 19090 | `/healthz` |

## First boot

The entrypoint (`entrypoint.sh`) on an empty data dir:

1. Generates/loads secrets into `/data/teamclu/secrets.env` (Postgres password,
   `JWT_SECRET`, derived `ANON_KEY` / `SERVICE_ROLE_KEY`, the `MQTT_SERVICE_TOKEN`
   (an HS256 JWT signed with `JWT_SECRET`), and the cron token).
2. Boots Postgres via the base image's **own** `docker-entrypoint.sh`, so the
   first-boot init-scripts create the Supabase roles, the `auth` schema +
   tables, the `extensions` schema, and the `storage` schema.
3. Promotes `postgres` to superuser (via `supabase_admin`) and applies
   `roles.sql` (role login passwords) + `jwt.sql` (`app.settings.jwt_secret`).
4. Runs **GoTrue migrations** (`gotrue migrate`) to bring `auth.users` up to
   date (adds e.g. the `phone` column the app migrations reference).
5. Runs **storage-api** standalone once so it self-migrates the `storage.*`
   tables (`buckets` / `objects`) — required before the app baseline.
6. Applies the **real** Supabase migrations from
   `services/supabase/migrations/*.sql` (baseline creates `public.orgs`,
   `public.users`, `public.plans` and all `amux.*` app tables).
7. Stops the bootstrap Postgres and hands off to `supervisord`.

Later boots skip steps 3–6 (data dir already initialised) and go straight to
`supervisord`.

## Build & smoke

Context is the **repo root**:

```bash
docker build --platform=linux/arm64 \
  -f deploy/self-host/all-in-one/Dockerfile \
  -t teamclu-selfhost-allinone:local .

# full smoke (build + run on :18080 + 8 assertions + restart)
deploy/self-host/all-in-one/smoke.sh
```

## Public endpoints

| Path | Target |
| --- | --- |
| `/healthz` | health responder |
| `/auth/v1/*` | GoTrue |
| `/rest/v1/*` | PostgREST |
| `/storage/v1/*` | storage-api |
| `/mqtt` | NanoMQ (WebSocket) |
| raw MQTT (non-HTTP bytes on the same port) | NanoMQ (TCP 1883, via Caddy layer4) |
| `/v1/*`, `/api/*` | FC Cloud API |
| `/fc-health/*` | FC (health probe passthrough) |
| `/` | landing string |

Client config uses a single base URL:

```dotenv
PUBLIC_BASE_URL=http://127.0.0.1:8080
VITE_CLOUD_API_URL=http://127.0.0.1:8080/v1
VITE_MQTT_WS_URL=ws://127.0.0.1:8080/mqtt
```

TCP-only MQTT clients (rumqttc on desktop/daemon, CocoaMQTT on iOS) connect to
the **same port** with `mqtt://127.0.0.1:8080` — see "single-port MQTT" below.

## Architecture / libc notes

The `supabase/postgres:17.6.1.106` base image is **Alpine / musl** (on both
amd64 and arm64 — it is a nix-on-Alpine build, *not* Ubuntu). The other service
binaries are grafted on top:

- **GoTrue** `auth` is a static Go binary — runs as-is.
- **storage-api** ships its own **musl** node (`/opt/storage/bin/node`); it runs
  natively and is reused to run **FC** (FC is pure JS, no native deps).
- **PostgREST** is a glibc (Ubuntu) binary; it is launched through its own
  bundled glibc loader + libs (`run-postgrest.sh`).
- **NanoMQ** is a musl/Alpine MQTT broker — it runs natively on the base image
  (binary copied from `emqx/nanomq:0.23.10`, `/usr/local/nanomq/nanomq`).

The build targets `linux/arm64` (see `smoke.sh`); the bundled glibc lib paths in
the Dockerfile are arch-named (`aarch64-linux-gnu`). For an amd64 build those
`COPY` paths would need to change to `x86_64-linux-gnu`.

### MQTT / NanoMQ

The broker is **NanoMQ** (musl-native, runs on the Alpine base — no glibc graft).
Client authentication is unchanged from the app's perspective: clients present an
**HS256 JWT** (signed with `JWT_SECRET`) as the MQTT password.

NanoMQ gates the MQTT **CONNECT** via its HTTP auth hook, which POSTs
`{username,password,clientid}` (form-encoded) to a tiny dependency-free validator
(`mqtt-auth.mjs`, run on the bundled musl node at `127.0.0.1:9091`). The validator
verifies `password` is a JWT with a valid HS256 signature over `header.payload`
using the raw `JWT_SECRET` and is not expired — returning `200` to allow, `403`
to deny. This is CONNECT-only gating (no per-topic ACL), matching the previous
authenticate-only setup. FC connects with `MQTT_USERNAME=fc-service` and
`MQTT_PASSWORD=$MQTT_SERVICE_TOKEN` (itself a JWT signed with `JWT_SECRET`).

#### Single-port MQTT (raw TCP + WS on :8080)

Caddy is built with the [caddy-l4](https://github.com/mholt/caddy-l4) plugin
(`xcaddy` stage in the Dockerfile). The public `:8080` is a **layer4 server**:

- connections whose first byte is `0x10` (the MQTT CONNECT fixed header) are
  proxied to NanoMQ's TCP listener on `127.0.0.1:1883`;
- everything else (HTTP, including WebSocket upgrades on `/mqtt`) goes to the
  internal HTTP site on `127.0.0.1:8089` (all the routes above).

MQTT is matched **first, by leading byte** — the inverse (`http` matcher first,
MQTT as fallthrough) hangs real clients: the http matcher waits for a complete
request line, an MQTT CONNECT usually contains no `0x0A` byte, and the layer4
matching timeout then *aborts* the connection instead of falling through.

So browser/RN clients use `ws(s)://<host>:<port>/mqtt` and raw-TCP clients use
`mqtt://<host>:<port>` — one published port, no extra config. Auth is the same
JWT-as-password in both cases. `render-config.sh` also exports
`MQTT_PUBLIC_TCP_BROKER_URL` to FC, which surfaces it to clients as
`mqtt.tcpUrl` in `GET /v1/config/bootstrap`.

Caveat: if an external proxy/LB terminates TLS in front of the container and
only speaks HTTP, raw MQTT won't pass through it — the layer4 split works for
direct TCP exposure of the container port (or an L4/TCP-mode LB).

### Vendor tarball (generated-Dockerfile pipelines)

Some corporate CI pipelines generate their own Dockerfile (base image +
`run_commands`) and can express neither the multi-stage graft nor pulls from
the upstream registries. For those, build this image where you can, then:

```bash
deploy/self-host/all-in-one/export-vendor-tarball.sh <image> vendor.tar.gz
```

Host the tarball on internal object storage and unpack it onto any
glibc/Ubuntu base in `run_commands` — the script header documents the exact
five-line recipe (tools via apt, `postgres` user, curl + sha256 check, untar
to `/`, fail-fast asserts). `entrypoint.sh` prepends the nix profile bin dir
to `PATH` itself, so no ENV wiring is needed. Do **not** symlink the nix
binaries into `/usr/local/bin` instead: Postgres resolves its share directory
from the binary path and fails on `postgres.bki`.

Caveats: linux/amd64 only; the tarball embeds the FC build and supabase
migrations, so regenerate it when `services/fc/` or
`services/supabase/migrations/` change; deploy as a single instance
(stop-then-start, not blue/green — two containers on one `/data` means two
Postgres on one data dir).

### storage-api

storage-api runs **live** as a supervised service and also performs the one-time
`storage.*` schema migration during first boot. The schema migration is
mandatory; the live service is best-effort (it runs on its own bundled musl
node, which works on this base).

## Persistence

All state is under `/data` (mount a volume):

```text
/data/teamclu/secrets.env
/data/postgres/
/data/storage/
/data/nanomq/
/data/caddy/
/data/logs/
```
