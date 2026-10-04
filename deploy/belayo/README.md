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

## Protected FC origins

The [Cloud API origin runbook](../../services/fc/README.md#protected-fc-app-origins)
defines the server-only `APPS_FC_ORIGIN_KEYRING`,
`APPS_FC_ORIGIN_TLS_CERT_NAME`, `APPS_FC_ORIGIN_TLS_CERT_PEM` and
`APPS_FC_ORIGIN_TLS_KEY_PEM`. All four names are in `cloud-api.env.keys`; that
manifest is an allowlist contract, not a secret injector. New/normal app
deployments also require `APPS_FC_ROUTE_DOMAIN`, a distinct public zone, a valid
Host-covering certificate and JWT-protected HTTPS origin. Internal DNS alone
does not prevent public FC Host overrides.

Before a separately authorized release, generate the independent master key
offline and set the four values in Dokploy's protected Cloud API environment.
The keyring is single-line JSON; the two PEM values must contain real newline
bytes. Use the deployment's supported multiline/quoted environment entry,
preserving each PEM as **one variable**. Do not paste raw PEM lines as separate
`KEY=value` records or use literal `\n`: FC does not unescape them. If the
chosen UI/API entry cannot retain newlines, stop and use a supported secret
injection path rather than flattening PEM or printing it to debug output.

`.github/scripts/belayo-rollout.sh` updates the Swarm image and Dokploy's
desired image only; it neither serializes multiline PEM nor updates service
environment values. Editing Dokploy desired config or adding allowlist names
does not prove the running service received them. Apply the environment through
an explicitly authorized Dokploy Cloud API deployment, then run the runbook's
secret-safe `readAppsOriginAuthConfig` / `assertOriginCertificate` check inside
the running Cloud API container for the chosen canonical origin Host. Keep
shell tracing disabled and never record `docker service inspect` env output.

After server config is applied, use TeamClu to initiate the chosen app's normal
deployment and verify provider readback before claiming protection. Server/image
restart does not upload or renew the FC custom-domain certificate. Start expiry
alerts 30 days before expiry; renewal requires secure server PEM replacement
followed by a later explicitly requested normal target deployment. The existing
Traefik wildcard renewal described below covers public app ingress only.
Follow the runbook's two-version rotation: prepare **every protected target
using the keyring** in separately authorized normal deploys before switching
the signing key, wait more than 60 seconds after all old signers stop, and remove
old validation keys only through subsequent authorized target deployments.
Never restore anonymous ingress on rollback. Existing apps are not repaired by
this release and remain unverified until their own normal redeploy.

The [new-app acceptance checklist](../../docs/testing/2026-10-04-fc-origin-lockdown.md)
is **尚未执行**; local SDK tests are not evidence of live FC rejection.

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
| App wildcard/custom domains | Caddy on-demand TLS | Traefik file routes; custom domains from the HTTP provider | Intentionally different |

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

## App ingress and wildcard certificate

App traffic reaches the Cloud API through Traefik dynamic files on the Dokploy
manager (`/etc/dokploy/traefik/dynamic/`), not through Dokploy's domain table:

- `teamclu-apps-ingress.yml` routes `login.apps.mx5.cn` and every app vanity
  host (`<slug>-<id8>.apps.mx5.cn`) and declares the `teamclu-apps-cloud-api`
  service.
- Verified user custom domains are not in a file. Traefik's HTTP provider
  polls the Cloud API's `/internal/traefik/dynamic`, which answers with one
  `Host` router pair per verified domain whose DNS already reaches the ingress,
  routed to `teamclu-apps-cloud-api@file` with certificates from the
  `letsencrypt` resolver (HTTP-01). Binding and verifying a domain in the app
  control panel is all it takes; unbinding removes the routes on the next poll.
  The provider is configured once in `traefik.yml`:

  ```yaml
  providers:
    http:
      endpoint: http://teamclu-cloud-api-shadow-qjau6z:9000/internal/traefik/dynamic
      pollInterval: 15s
      headers:
        Authorization: Bearer <APPS_TRAEFIK_PROVIDER_TOKEN>
  ```

  The same token is the Cloud API's `APPS_TRAEFIK_PROVIDER_TOKEN`. A failed poll
  keeps Traefik's last routes, so the endpoint answers 503 on errors and never
  an empty list. `app-custom-domains.yml` is the manual fallback and should stay
  empty.
- `teamclu-apps-wildcard-cert.yml` declares the `*.apps.mx5.cn` certificate,
  whose PEMs live in `certificates/teamclu-apps-wildcard/`. The declaration is
  top level because Traefik watches `dynamic/` and the files directly in it and
  skips subdirectories, while any event there reloads the whole tree — a
  declaration next to the PEMs is loaded at startup but never reloaded.
- The Cloud API application's own Dokploy file carries only
  `teamclaw-api.ucar.cc`. Dokploy adds and removes only the routers it names
  itself, and rewrites the file when it does, so edit it by parsing YAML rather
  than by matching text.

`mx5.cn` is on DNSPod, so Traefik cannot renew that certificate;
`.github/workflows/belayo-apps-wildcard-cert.yml` does. It runs every Monday,
renews when 30 days or fewer remain (DNS-01 via DNSPod with
`BELAYO_DNSPOD_SECRET_ID` / `BELAYO_DNSPOD_SECRET_KEY`), swaps the PEMs over SSH
keeping the previous pair as `*.prev`, rewrites the top-level
`teamclu-apps-wildcard-cert.yml` so Traefik reloads, confirms clients get the
new certificate or restores the old one, and alerts WeCom on failure. Run it manually with `force` to renew early, or with
`staging` to test issuance without touching the manager.
