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

**Supabase is the only backend.** There is no switch, no second repository, and
no ORM. Every `/v1` read and write goes through **`lib/supabase-repo.ts`** (plus
`lib/supabase-repo/*`): PostgREST with the caller's bearer forwarded, so RLS and
auth semantics are preserved. Login is GoTrue, via
`createSupabaseAuthRepository`. Set-based work lives in Postgres functions
called with `.rpc()`, not in application SQL.

**FC opens no connection of its own to the control-plane database.** No
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

### No scheduled work

FC runs nothing on a timer. The two OSS-sync cleanup tasks
(`oss-abandon-sessions`, `oss-gc-blobs`) and their `/internal/cron` trigger were
removed, along with the plpgsql functions they were ported from — neither copy
had ever run on a deployment. `amuxc_upload_sessions` and `amuxc_blobs` now grow
without bound; whatever collects them next needs the object store in scope, not
just the registry.
