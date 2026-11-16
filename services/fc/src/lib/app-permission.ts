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
