# teamclu-fc

The TeamClu Cloud API (Hono). It runs as a standalone Docker container in the
self-host test environment and in Belayo Dokploy. Alibaba Function Compute is
still used for user-deployed Apps, but no longer hosts the Belayo Cloud API.

## Run in Docker (self-host)

The container serves the full `/v1` API plus `/healthz`.
All backing services (Supabase, OSS, MQTT, the AI gateway) stay external and
are configured through the container environment allowlist.

```bash
cp .env.example .env   # fill in the values
docker compose up --build
curl http://127.0.0.1:9000/healthz   # {"ok":true}
```

### Container-specific env vars

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `9000` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |

All other vars (Supabase, OSS, APNs, MQTT, Apps/CodeUp) are kept in parity with
`deploy/belayo/cloud-api.env.keys` by `test/deploy-env-parity.test.ts`.

## Protected FC app origins

This is a runbook for a separately authorized server release and subsequent
normal deployment of a chosen app. Local implementation does not establish
cloud acceptance. The [acceptance record](../../docs/testing/2026-10-04-fc-origin-lockdown.md)
starts at **尚未执行**. Existing apps are not repaired or migrated by this change;
their old HTTP/default endpoints remain `legacy_unverified` until their owner
explicitly initiates a normal redeploy. Do not claim these apps are safe.

New deployments keep the standard HTTP Trigger but explicitly disable its
default public URL (`disableURLInternet: true`). Their custom origin must be
HTTPS-only with FC JWT verification of `X-Teamclu-Origin-Authorization`, without
claim-to-identity-header mapping. The gateway owns platform identity headers;
the application's `Authorization` and Cookie remain independent. A CNAME to an
internal FC address supplies routing, **not** access control: the same custom
Host can reach the public account FC ingress, so JWT validation is required.

### Prepare server-only configuration

`APPS_FC_ROUTE_DOMAIN` must differ from `APPS_PUBLIC_DOMAIN`. The certificate must
cover each canonical origin Host (`<slug>-<id8>.<APPS_FC_ROUTE_DOMAIN>`; use the
platform-generated label for non-ASCII slugs).

| Variable | Required value |
| --- | --- |
| `APPS_FC_ORIGIN_KEYRING` | JSON `{"active":{"version":"v1","key":"<base64url-master-key>"}}`; optional `previous` has the same shape and a distinct version |
| `APPS_FC_ORIGIN_TLS_CERT_NAME` | Nonempty certificate name sent to FC |
| `APPS_FC_ORIGIN_TLS_CERT_PEM` | Full PEM certificate chain, with real newline bytes |
| `APPS_FC_ORIGIN_TLS_KEY_PEM` | Matching PEM private key, with real newline bytes |

Generate the independent master key **offline**, using at least 32 cryptographically
random bytes. Do not reuse login JWT, Supabase, app-session or agent-management
keys. For example, on a trusted offline administration machine, this writes a
mode-0600 file without printing the key:

```bash
umask 077
node --input-type=module -e 'import {randomBytes} from "node:crypto"; import {writeFileSync} from "node:fs"; writeFileSync("origin-keyring.json", JSON.stringify({active:{version:"v1",key:randomBytes(32).toString("base64url")}}), {mode:0o600,flag:"wx"});'
```

Keep that version stable across restarts; never generate a key at server startup.
Transfer the keyring, issued certificate chain and private key through the
deployment's secret channel. They belong only in the platform server environment,
never in app-function env, agent output, source control, logs or deployment
previews. Symmetric JWKS returned by FC management APIs is also secret; do not
record full `authConfig`, JWTs, keys or PEM in status/acceptance reports.

For self-host, edit `deploy/self-host/.env` with mode 0600. Compose accepts
single-quoted multiline values: paste the **actual** certificate/key lines
between the quotes. The example below is deliberately unusable:

```dotenv
APPS_FC_ORIGIN_KEYRING='{"active":{"version":"v1","key":"<offline-generated-base64url-key>"}}'
APPS_FC_ORIGIN_TLS_CERT_NAME=teamclu-origin-v1
APPS_FC_ORIGIN_TLS_CERT_PEM='-----BEGIN CERTIFICATE-----
<issued certificate chain; real newlines>
-----END CERTIFICATE-----'
APPS_FC_ORIGIN_TLS_KEY_PEM='<matching private key; real newlines>'
```

Literal `\n` strings are not decoded by the FC config loader. Do not use
`docker compose config`, `printenv`, shell tracing or service-inspect env output
to check secrets: these can print the entire keyring/private key. Apply the
updated server configuration after the compatible image is available:

```bash
cd deploy/self-host
docker compose up -d fc
docker compose exec -T fc node --input-type=module -e 'import {readAppsOriginAuthConfig,assertOriginCertificate} from "./dist/lib/apps-origin-auth.js"; const config=readAppsOriginAuthConfig(process.env); assertOriginCertificate(config,process.argv[1]); console.log("origin configuration valid for target Host");' '<canonical-target-origin-host>'
```

This validates the values actually received by FC without exposing them. It
does not upload a certificate to Alibaba FC. A changed image must first be built
or loaded through the deployment's normal release procedure; `up -d fc` applies
the env and existing image. See the [Belayo-specific procedure](../../deploy/belayo/README.md#protected-fc-origins)
for Dokploy, whose image rollout does not sync environment changes.

On the secured administration machine, verify Host coverage, current validity
and matching key before injection. Use the full canonical target Host, not only
the parent zone. Public-key hashes may be compared locally; private PEM stays
in files, never command arguments or output:

```bash
openssl x509 -in fullchain.pem -noout -checkhost '<canonical-target-origin-host>'
openssl x509 -in fullchain.pem -noout -dates
openssl x509 -in fullchain.pem -noout -checkend 2592000
openssl x509 -in fullchain.pem -noout -pubkey | openssl pkey -pubin -outform DER | openssl sha256
openssl pkey -in privkey.pem -pubout -outform DER | openssl sha256
```

The config loader additionally checks not-before/not-after, matching key and
SAN-aware Host coverage. Missing keyring/route/TLS configuration, invalid keys,
expired/not-yet-valid or mismatched certificates block deployment with a safe
`503 origin_security_unavailable`. Extra HTTP Triggers or unsafe same-function
custom-domain aliases produce `409 origin_security_drift`; readback failures
block publication. No unverified/default HTTP fallback is published or marked
Live. Do not work around a failed preflight by reopening anonymous access.

### Apply and renew a target certificate

After applying server configuration, open the chosen app in TeamClu and ask its
Agent to perform that app's normal deployment. Preflight must pass; finalize
must read back the disabled default URL, HTTPS-only/JWT custom domain and
expected verification keys before reporting Live and persisting the HTTPS
endpoint. Retry failures through the same normal deploy path; do not silently
modify other apps or extra entrypoints.

Monitor certificate expiry **starting 30 days before expiry**, including the
certificate served by each protected target. `openssl x509 -checkend 2592000`
returns nonzero inside that window; route the alert to the deployment operator.
Obtain renewal from the issuer, repeat Host/date/key checks, securely replace
the two server PEM values (and certificate name if changed), and apply server
config with the command above or the authorized Dokploy procedure. **Restarting
the server does not update the uploaded FC certificate.** A later explicitly
requested normal deployment of each chosen target uploads and verifies the
renewed certificate; check that target's live TLS certificate and expiry after
deployment. This runbook adds no scheduled FC certificate updater or bulk app
repair. The Belayo public `*.apps.mx5.cn` Traefik renewal workflow does not renew
these FC origin certificates.

### Rotate the master key without breaking protected origins

The keyring supports at most `active` and `previous`; versions select `kid` and
derive independent per-app HS256 verification keys. Gateway signing uses only
`active`. Rotation requires an explicit schedule for **all protected targets
using this keyring**, not just a convenient test app:

1. Generate a new independent key/version offline. Keep the current signing
   version as `active` and stage the new version as `previous`; apply that
   server config. This stages validation without switching the signer.
2. In separately authorized normal deployments, prepare every protected target
   using this keyring with both versions in FC JWKS. Check each target's safe
   security summary and authorized secret-safe verification of key IDs. Do not
   auto-update unrelated apps. If any protected target cannot be prepared,
   postpone the signing switch and retain the current active key.
3. Only when **all** those targets accept both versions, swap keyring roles
   (new `active`, old `previous`) and apply server config. Verify gateway traffic
   and account for all gateway instances using the shared keyring.
4. Wait **more than 60 seconds after the last old signer stops**, confirm all
   targets remain compatible, then remove `previous` from server config and
   apply it. Remove the old validation key from each target only through its
   later separately authorized normal deployment. Retaining old JWKS during
   that interval is an explicit residual risk, not completed revocation.

JWTs expire within 60 seconds. A leaked credential can still be replayed against
the **same** app in that window; there is no nonce store or single-use guarantee.
Credentials travel only over HTTPS in the dedicated request header and must
not enter browser responses, query strings or logs. Distinct app-derived keys
reject A's credential at B. Rollback must preserve disabled default URL and
origin authentication: use a compatible gateway/keyring or return explicit
unavailability. Never roll back to anonymous triggers/domains.

## Data access (read before changing Cloud API data access)

**Supabase is the only backend.** There is no switch, no second repository, and
no ORM. Every `/v1` read and write goes through **`lib/supabase-repo.ts`** (plus
`lib/supabase-repo/*`): PostgREST with the caller's bearer forwarded, so RLS and
auth semantics are preserved. Login is GoTrue, via
`createSupabaseAuthRepository`. Set-based work lives in Postgres functions
called with `.rpc()`, not in application SQL.

**The Cloud API opens no connection of its own to the control-plane database.** No
`getDb()`, no Drizzle, no `DATABASE_URL`. The one place raw SQL survives is the
Apps module, and it is not this database: `lib/provisioning/app-postgres.ts`
provisions a schema + scoped login role per app (DDL PostgREST cannot express),
and `lib/provisioning/app-data-db.ts` browses the user's own tables in the
per-org database. Both connect over `APPS_DB_ADMIN_URL`.

The schema lives in **`services/supabase/migrations/`** and nowhere else,
applied by `deploy/self-host/init/apply-migrations.sh`, and is tested by the
pgTAP suite in `services/supabase/tests/`. There used to be a second copy under
`src/db/` for the ORM; it was deleted because it validated only itself — nothing
applied it, and a drift from the real migrations still passed.

### Developer checklist (new Cloud API work)

1. **Contract first** — `lib/repository-contract.ts`, then OpenAPI.
2. **Implement** in `supabase-repo.ts` (or `supabase-repo/*`).
3. **Shared validation** — request-shape and security rules that the route
   layer and the repository both apply live in `lib/validation/`; keep them free
   of PostgREST calls.
4. **Tests** — `test/repository-contract.test.ts` is the contract gate; domain
   tests sit alongside it.

Entry wiring: `src/index.ts` (`makeBusinessRepoFactory` / `makeAuthRepoFactory`).

### No in-process scheduler

The Cloud API has no in-process timer. Belayo and self-host each run one cron
sidecar that calls the authenticated app-cron tick endpoint. The two OSS-sync cleanup tasks
(`oss-abandon-sessions`, `oss-gc-blobs`) and their `/internal/cron` trigger were
removed, along with the plpgsql functions they were ported from — neither copy
had ever run on a deployment. `amuxc_upload_sessions` and `amuxc_blobs` now grow
without bound; whatever collects them next needs the object store in scope, not
just the registry.
