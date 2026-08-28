/**
 * FC database access switch — see README.md § "Dual backend paths".
 *
 * BACKEND_KIND selects between two parallel implementations of the same Cloud
 * API repository contract:
 *
 *   supabase (default, production) — PostgREST + caller JWT + RLS
 *     lib/supabase-repo.ts, lib/supabase-repo/*
 *
 *   postgres — Drizzle direct SQL + Better-Auth JWT + app-layer authz
 *     lib/pg-repo/*
 *
 * New repository methods, sync handlers, push/vanity helpers, and shared
 * validation rules must be implemented (or explicitly stubbed) on BOTH paths
 * unless the change is supabase-only by design (e.g. phone auth).
 *
 * Side paths (cron, LiteLLM usage, per-app DB) use Drizzle regardless of
 * BACKEND_KIND; they are not the postgres backend path.
 */
export function resolveBackendKind(
  env: NodeJS.ProcessEnv = process.env,
): "supabase" | "postgres" {
  return env.BACKEND_KIND === "postgres" ? "postgres" : "supabase";
}
