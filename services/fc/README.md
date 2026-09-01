# teamclu-fc

The TeamClu Cloud API (Hono). It can run on Alibaba Function Compute via
`s.yaml`, and also runs as a standalone Docker container for self-hosting.

## Run in Docker (self-host)

The container serves the full `/v1` API plus `/healthz`.
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

All other vars (Supabase, OSS, APNs, MQTT, Apps/CodeUp) match `s.yaml`.

## Data access (read before changing FC data access)

All `/v1` business data goes through **`lib/supabase-repo.ts`** (plus
`lib/supabase-repo/*`): PostgREST with the caller's bearer forwarded, so RLS
and auth semantics are preserved. Login is GoTrue, via
`createSupabaseAuthRepository`.

**FC opens no connection of its own to the control-plane database.** There is
no `getDb()` and no `DATABASE_URL` any more: every `/v1` read and write goes
through PostgREST. The one place raw SQL survives is the Apps module, which
provisions and browses a *separate* database per org — `lib/provisioning/
app-postgres.ts` and `app-data-db.ts`, on `APPS_DB_ADMIN_URL`.

`src/db/` (the Drizzle schema + migrations) is now **test-only**, and nothing in
`src/` imports it. It is what `test/db/pglite.ts` replays to build an in-memory
database for `test/db/*.test.ts`. It is not applied to any deployment — the live
schema is `services/supabase/migrations/`, applied by
`deploy/self-host/init/apply-migrations.sh`. Treat a divergence between the two
as a stale fixture, not a pending migration.

### Developer checklist (new Cloud API work)

1. **Contract first** — `lib/repository-contract.ts`, then OpenAPI.
2. **Implement** in `supabase-repo.ts` (or `supabase-repo/*`).
3. **Shared validation** — request-shape and security rules that the route
   layer and the repository both apply live in `lib/validation/`; keep them free
   of PostgREST/Drizzle calls.
4. **Tests** — `test/repository-contract.test.ts` is the contract gate; domain
   tests sit alongside it.

Entry wiring: `src/index.ts` (`makeBusinessRepoFactory` / `makeAuthRepoFactory`).

### No scheduled work

FC runs nothing on a timer. The two OSS-sync cleanup tasks
(`oss-abandon-sessions`, `oss-gc-blobs`) and their `/internal/cron` trigger were
removed, along with the plpgsql functions they were ported from — neither copy
had ever run on a deployment. `amuxc_upload_sessions` and `amuxc_blobs` now grow
without bound; whatever collects them next needs the object store in scope, not
just the registry.
