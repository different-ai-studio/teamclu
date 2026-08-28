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
| `BACKEND_KIND` | `supabase` | `supabase` or `postgres` (via `resolveBackendKind`) |

All other vars (DB, Supabase, OSS, LiteLLM, APNs, MQTT, CodeUp) match `s.yaml`.

## Dual backend paths (read before changing FC data access)

Production self-host uses **`BACKEND_KIND=supabase`** (default). The codebase
also carries a parallel **`postgres`** path (Drizzle + Better-Auth) for the same
`/v1` repository contract. Treat them as **two implementations of one API**,
not as “main vs dead code”, until the postgres path is removed.

| Path | Switch | Business `/v1/*` | Auth |
|------|--------|------------------|------|
| **A — Supabase** | default / `supabase` | `lib/supabase-repo.ts` → PostgREST + RLS | GoTrue via `createSupabaseAuthRepository` |
| **B — Postgres** | `BACKEND_KIND=postgres` | `lib/pg-repo/*` → Drizzle + `authz.ts` | Better-Auth via `createPgAuthRepository` |

**Not Path B** (Drizzle exists on supabase deployments too): `lib/cron.ts`,
`lib/litellm-usage.ts`, `lib/provisioning/app-postgres.ts` — tokenless or
separate DB; always wired regardless of `BACKEND_KIND`.

### Developer checklist (new Cloud API work)

1. **Contract first** — `lib/repository-contract.ts`, then OpenAPI.
2. **Implement both** — `supabase-repo.ts` (or `supabase-repo/*`) **and**
   `pg-repo/<domain>.ts`, unless the feature is explicitly supabase-only.
3. **Branching modules** — if you touch `sync-handlers.ts`, `sync-auth.ts`,
   `push-deps.ts`, or `apps-vanity.ts`, update **both** the `postgres` and
   `supabase` blocks (grep `resolveBackendKind()`).
4. **Shared validation** — pure helpers imported from `pg-repo/` into
   supabase-repo (e.g. `app-status`, `team-mcp`, `team-env-secrets`) must stay
   backend-neutral; do not put PostgREST calls there.
5. **Tests** — `test/repository-contract.test.ts` (supabase stub gate) and
   `test/pg-repo-contract.test.ts` (pglite gate); domain tests often have
   `pg-repo-*.test.ts` twins.

Entry wiring: `src/index.ts` (`makeBusinessRepoFactory` / `makeAuthRepoFactory`).
Switch: `src/lib/backend-kind.ts`.

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
