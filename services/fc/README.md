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

Dev and prod use an **HTTP** connection from the TeamClu gateway to the FC
custom-domain origin. Public app URLs remain HTTPS at Caddy/Traefik. This removes
the FC-origin certificate requirement, but the internal hop carries the origin JWT,
business Authorization/Cookie and platform identity headers in plaintext. Operators
must treat that network path as trusted; an internal DNS name alone does not stop
public FC Host overrides. FC JWT verification is still mandatory.

New deployments keep the standard HTTP Trigger with `disableURLInternet: true`.
The custom domain is HTTP-only with FC JWT verification of
`X-Teamclu-Origin-Authorization`, and no claim-to-identity-header mapping. The
gateway replaces any client-supplied origin credential or platform identity headers;
application Authorization and Cookie values remain independent. Finalize reads back
the trigger, domain, JWT keys and all extra entrypoints before marking an app Live.
Existing apps are not repaired by this change; read-only status remains
`legacy_unverified` until a separately requested normal redeploy. An old canonical
HTTP endpoint may receive a gateway JWT, but that does not make its unprotected FC
entrypoint safe; only FC readback can establish protection.

### Prepare server-only configuration

Set `APPS_FC_ROUTE_DOMAIN` to a distinct origin zone, different from
`APPS_PUBLIC_DOMAIN`. It must route each canonical origin Host
(`<slug>-<id8>.<APPS_FC_ROUTE_DOMAIN>`) to FC. Configure
`APPS_FC_ORIGIN_KEYRING` in **both dev and prod** as JSON
`{"active":{"version":"v1","key":"<base64url-master-key>"}}` with an independent,
cryptographically random master key of at least 32 bytes. An optional `previous`
entry has the same shape and a different version. Do not reuse login, Supabase,
app-session or agent-management keys. Keep each environment's keyring stable
across restarts; never generate it at service startup.

The keyring is a server-only secret. Never put it in an app-function environment,
agent output, source control, logs or deployment previews. Symmetric JWKS from FC
management APIs is secret too. Generate and deliver the keyring through the
approved deployment secret channel; do not print it or pass it in shell arguments.
Configure the keyring **before** switching the gateway image, since old canonical
HTTP apps can require the signer after the switch. If it is missing, protected
traffic fails closed rather than falling back to unsigned forwarding.

For self-host, put the single-line JSON keyring in `deploy/self-host/.env` (mode
0600), rebuild/restart FC through the normal release, then check the running
container without printing secret values:

```bash
cd deploy/self-host
docker compose exec -T fc node --input-type=module -e 'import {readAppsOriginAuthConfig} from "./dist/lib/apps-origin-auth.js"; readAppsOriginAuthConfig(process.env); console.log("origin configuration valid");'
```

For prod, use the [Belayo procedure](../../deploy/belayo/README.md#protected-fc-origins)
to set the keyring in Dokploy and roll the Cloud API image. A normal app deploy
then configures its HTTP-only custom domain and verifies JWT readback. Missing
keyring/route configuration blocks deployment with safe `503
origin_security_unavailable`; extra HTTP Triggers, unsafe aliases or JWT/domain
drift block publication with `409 origin_security_drift`. Do not reopen anonymous
access as a workaround.

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
Credentials travel over HTTP on the origin hop in the dedicated request header;
they must not enter browser responses, query strings or logs. Distinct app-derived keys
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
