# Belayo deployment contract

## Cloud API cron heartbeat

`cloud-api-cron.compose.yml` is the single Belayo scheduler for the Cloud API.
Keep `APP_CRON_REPLICAS=1` in Dokploy and verify one due test job creates
exactly one run record in one minute. The retired Cloud API FC function and its
timer no longer exist, so rollback is an image/config rollback inside Dokploy.

Belayo runs hosted workloads under Dokploy while self-host remains the
Docker Compose test environment. The reverse proxies intentionally differ:
Traefik owns Belayo hostnames and Caddy owns self-host hostnames.

The environments must still agree on:

- application environment-variable names;
- Cloud API port 9000 and AI Gateway port 4001;
- image-provided /healthz checks;
- Cloud API-to-AI-Gateway routing semantics;
- immutable image tags and rollback-capable rolling updates.

The .env.keys files are names-only manifests. They contain no values and are
safe to review in Git. Tests compare them with the corresponding self-host
Compose allowlists so adding a variable to only one environment fails CI.

Intentional Cloud API difference: `FC_SUPABASE_URL` exists only in self-host to
select bundled versus external Supabase. Both targets are containers and expose
`PORT` and `HOST`; neither Caddy nor Traefik adds Cloud API CORS headers.

Secrets remain in the self-host .env, GitHub environments, and Dokploy. Never
add secret values to these manifests.

## Cloud API release pipeline

`.github/workflows/belayo-cloud-api.yml` builds `services/fc` as an immutable
amd64 image, pushes it to Alibaba ACR through the Dokploy manager, rolls
`teamclu-cloud-api-shadow-qjau6z` on `dokploy-worker-2`, and verifies both the
internal and public health endpoints before updating Dokploy's desired image.
It runs automatically for Cloud API changes merged to `main` and can also be
started manually.

The pipeline deliberately does not watch `services/supabase/migrations` and
contains no application-database migration step. Belayo database migrations
continue to be reviewed and applied manually before any Cloud API release that
depends on them. The SQL statement in the release workflow changes only the
Dokploy control-plane application's `dockerImage` field.

## Current route parity

| Capability | Self-host | Belayo | Status |
|---|---|---|---|
| Cloud API | Caddy to fc:9000 | Cloudflare + Traefik to cloud-api:9000 | Aligned |
| AI Gateway internal | ai-gateway:4001 | teamclu-ai-gateway-iiq8f3:4001 | Aligned |
| AI Gateway public | /ai/* on the Cloud API host | ai-gateway.service.ucar.cc | Intentional |
| MQTT WebSocket | Caddy to emqx:8083 | Traefik to emqx:8083 | Aligned |
| Registry | Caddy method-split auth | Traefik method-split auth | Aligned |
| Gitea HTTP | Caddy to gitea:3000 | Traefik to the managed external server | Intentional |
| App wildcard/custom domains | Caddy on-demand TLS | Alibaba FC custom domains for user Apps | Intentionally different |

Do not change production DNS, scheduler ownership, MQTT client URLs, or
database migrations as part of an environment-key parity change. Each needs
its own smoke test and rollback.

## MQTT endpoints

Belayo exposes the same client contract as self-host, while keeping the proxy
implementation environment-specific:

```text
MQTT_BROKER_URL=wss://mqtt.service.ucar.cc/mqtt
MQTT_PUBLIC_TCP_BROKER_URL=mqtt://transport.service.ucar.cc:1883
MQTT_USE_TLS=true
```

The Dokploy `emqx` Compose service owns an HTTPS domain with these settings:

- host: `mqtt.service.ucar.cc`
- service: `emqx`
- container port: `8083`
- path/internal path: `/`
- domain type: `compose`
- certificate: Let's Encrypt

After changing a Compose domain in Dokploy, reload the Compose deployment so
Traefik regenerates its dynamic route. A plain `GET /mqtt` returning EMQX 400
only proves routing; the deploy gate is a successful WebSocket 101 handshake
followed by an authenticated connect/subscribe/publish/receive roundtrip.

Rollback is additive and does not affect native clients: restore the previous
Cloud API MQTT variables, redeploy Cloud API, then remove the
`mqtt.service.ucar.cc` Compose domain and reload the `emqx` Compose service.
