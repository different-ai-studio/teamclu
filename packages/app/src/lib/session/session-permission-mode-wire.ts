import type { SessionPermissionMode } from "@/lib/session/session-permission-mode";

/** Wire value for daemon / cron (`PermissionPolicy::from_wire`). */
export function sessionPermissionModeToWire(mode: SessionPermissionMode): string {
  return mode === "fullAccess" ? "full_access" : "default";
}
