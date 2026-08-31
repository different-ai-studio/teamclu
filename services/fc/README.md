# teamclu-fc

The TeamClu Cloud API (Hono). It can run on Alibaba Function Compute via
`s.yaml`, and also runs as a standalone Docker container for self-hosting.

## Run in Docker (self-host)

The container serves the full `/v1` API plus `/healthz` and `/internal/cron`.
All backing services (Postgres/Supabase, OSS, MQTT, LiteLLM) stay external and
are configured through environment variables — the same set listed in `s.yaml`.

```bash
cp .env.example .env   # fill in the values (see s.yaml for the full list)
docker compose up --build
curl http://127.0.0.1:9000/healthz   # {"ok":true}
```

### Container-specific env vars

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `9000` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `CRON_TRIGGER_SECRET` | (unset) | Shared secret required by `/internal/cron` |

All other vars (DB, Supabase, OSS, LiteLLM, APNs, MQTT, CodeUp) match `s.yaml`.

## Data access (read before changing FC data access)

All `/v1` business data goes through **`lib/supabase-repo.ts`** (plus
`lib/supabase-repo/*`): PostgREST with the caller's bearer forwarded, so RLS
and auth semantics are preserved. Login is GoTrue, via
`createSupabaseAuthRepository`.

Drizzle is also present, but it is **not** a second business backend — it is
how the tokenless side paths reach Postgres directly: `lib/cron.ts`,
`lib/litellm-usage.ts`, `lib/apps-vanity.ts`, `lib/provisioning/app-secrets.ts`
and `lib/provisioning/app-postgres.ts`. Those need `DATABASE_URL`; the business
API does not.

`src/db/migrations/` is **not applied to any deployment**. The live schema is
`services/supabase/migrations/`, applied by `deploy/self-host/init/apply-migrations.sh`.
The Drizzle set exists so `test/db/pglite.ts` can build an in-memory database
for the tests that need real SQL (cron, oss-sync schema, app data browser) —
keep it in step with the real migrations for that reason, not for deployment.

### Developer checklist (new Cloud API work)

1. **Contract first** — `lib/repository-contract.ts`, then OpenAPI.
2. **Implement** in `supabase-repo.ts` (or `supabase-repo/*`).
3. **Shared validation** — request-shape and security rules that the route
   layer and the repository both apply live in `lib/validation/`; keep them free
   of PostgREST/Drizzle calls.
4. **Tests** — `test/repository-contract.test.ts` is the contract gate; domain
   tests sit alongside it.

Entry wiring: `src/index.ts` (`makeBusinessRepoFactory` / `makeAuthRepoFactory`).

### Cron (HTTP-triggered)

Alibaba FC drives cron via timer triggers. In Docker, an external scheduler
POSTs to `/internal/cron` instead. Run each task on its own schedule:

```bash
curl -X POST http://127.0.0.1:9000/internal/cron \
  -H "x-cron-secret: $CRON_TRIGGER_SECRET" \
  -H "content-type: application/json" \
  -d '{"task":"oss-abandon-sessions"}'

curl -X POST http://127.0.0.1:9000/internal/cron \
  -H "x-cron-secret: $CRON_TRIGGER_SECRET" \
  -H "content-type: application/json" \
  -d '{"task":"oss-gc-blobs"}'
```

Tasks: `oss-abandon-sessions`, `oss-gc-blobs`. A missing/wrong secret returns
401; an unknown task returns 400. If the server was started without cron support it returns 503.

The Alibaba FC entrypoint (`dist/index.handler`) and `s.yaml` are unchanged by
the Docker support.
