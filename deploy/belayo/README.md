# Belayo deployment contract

## Cloud API cron heartbeat

`cloud-api-cron.compose.yml` is the Dokploy/Swarm replacement for Alibaba
FC's one-minute `app-cron` timer. It is deliberately deployed with
`APP_CRON_REPLICAS=0` until production cutover. Scheduler handoff order is:

1. Disable the Alibaba FC `app-cron` timer.
2. Set `APP_CRON_REPLICAS=1` in the Dokploy Compose environment and redeploy.
3. Verify one due test job creates exactly one run record in one minute.

Rollback uses the reverse ownership order: scale the Dokploy stack to zero,
then re-enable the FC timer. Never run both schedulers concurrently.

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

Intentional Cloud API differences:

- FC_SUPABASE_URL exists only in self-host. Function Compute reserves the FC_
  prefix, and Belayo Dokploy sets SUPABASE_URL directly.
- CORS_HANDLED_BY_PROXY exists only in Alibaba Function Compute. Neither Caddy
  nor Traefik adds Cloud API CORS headers.
- PORT and HOST are explicit in container targets; Function Compute owns its
  runtime listener.

Secrets remain in the self-host .env, GitHub environments, and Dokploy. Never
add secret values to these manifests.

## Current route parity

| Capability | Self-host | Belayo | Status |
|---|---|---|---|
| Cloud API | Caddy to fc:9000 | FC production; Traefik shadow to cloud-api:9000 | Migration pending |
| AI Gateway internal | ai-gateway:4001 | teamclu-ai-gateway-iiq8f3:4001 | Aligned |
| AI Gateway public | /ai/* on the Cloud API host | ai-gateway.service.ucar.cc | Intentional |
| MQTT WebSocket | Caddy to emqx:8083 | Traefik to emqx:8083 | Aligned |
| Registry | Caddy method-split auth | Traefik method-split auth | Aligned |
| Gitea HTTP | Caddy to gitea:3000 | Traefik to the managed external server | Intentional |
| App wildcard/custom domains | Caddy on-demand TLS | Alibaba FC custom domains | Intentionally different |

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
