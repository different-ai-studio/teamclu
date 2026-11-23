import { ApiError } from "./http-utils.js";

/**
 * Per-app permission levels. They are Gitea's repository collaborator levels on
 * purpose, so the projection onto Gitea is the identity (spec
 * docs/specs/2026-11-16-app-platform-identity-design.md, decision 7).
 *
 *   read  — see the app and download its code
 *   write — change the code, read and write the app's data and files
 *   admin — deploy, grant, change settings and environment variables
 *
 * These used to be view / prompt / admin. Clients older than the rename still
 * send the old words; `parseAppPermissionLevel` accepts them and stores the new
 * ones, and nothing is ever returned under the old names.
 */
export type AppPermissionLevel = "read" | "write" | "admin";

const RANK: Record<AppPermissionLevel, number> = { read: 0, write: 1, admin: 2 };

const LEGACY: Record<string, AppPermissionLevel> = { view: "read", prompt: "write" };

export function isAppPermissionLevel(raw: unknown): raw is AppPermissionLevel {
  return raw === "read" || raw === "write" || raw === "admin";
}

/** A level from client input, old names included. Throws 400 on anything else. */
export function parseAppPermissionLevel(raw: unknown): AppPermissionLevel {
  const value = typeof raw === "string" ? raw.trim() : raw;
  if (typeof value === "string" && value in LEGACY) return LEGACY[value];
  if (isAppPermissionLevel(value)) return value;
  throw new ApiError(400, "validation_failed", "permissionLevel must be read, write, or admin");
}

/** A level read back from the database. Unknown values are no access. */
export function storedAppPermissionLevel(raw: unknown): AppPermissionLevel | null {
  if (isAppPermissionLevel(raw)) return raw;
  if (typeof raw === "string" && raw in LEGACY) return LEGACY[raw];
  return null;
}

export function appLevelAtLeast(level: AppPermissionLevel, min: AppPermissionLevel): boolean {
  return RANK[level] >= RANK[min];
}

/** The higher of two levels; either may be absent. */
export function higherAppLevel(
  a: AppPermissionLevel | null | undefined,
  b: AppPermissionLevel | null | undefined,
): AppPermissionLevel | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * The level an inherited agent gets in Gitea. Gitea's `admin` collaborator
 * adds nothing an agent needs — merging a PR is `write` — and is the level
 * that could change the repo's settings, so an agent that inherits `admin`
 * from the app's creator is mirrored as `write`. The Cloud API still treats it
 * as admin for deploys (see agent inheritance in supabase-repo).
 */
export function inheritedGiteaLevel(level: AppPermissionLevel): AppPermissionLevel {
  return level === "admin" ? "write" : level;
}

/**
 * Call one of the agent-inheritance functions of 20261120120000
 * (`app_inherited_agents`, `agent_inherited_app_level`).
 *
 * A database that has not had that migration yet answers PGRST202 (not in
 * PostgREST's schema cache) or 42883 (no such function). That reads as "no
 * agent inherits anything" — exactly the behaviour before the migration —
 * rather than failing every agent's permission check, the Gitea sync and the
 * access tab. Belayo applies migrations by hand, so the image can land first.
 */
export async function callAgentInheritance(client: any, fn: string, args: Record<string, unknown>): Promise<any> {
  const { data, error } = await client.rpc(fn, args);
  if (!error) return data;
  if (error.code === "PGRST202" || error.code === "42883") return null;
  throw error;
}
