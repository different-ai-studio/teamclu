import type { SessionMessage } from "./session-types";

export type PermissionOption = { id: string; kind: string; name: string };

/** The agent's offered choices on a `permission_request` row. */
export function permissionOptionsOf(message: Pick<SessionMessage, "metadata">): PermissionOption[] {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object") return [];
  const raw = (metadata as Record<string, unknown>).options;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((o) => {
    if (!o || typeof o !== "object") return [];
    const r = o as Record<string, unknown>;
    return typeof r.id === "string" && r.id
      ? [{ id: r.id, kind: typeof r.kind === "string" ? r.kind : "", name: typeof r.name === "string" ? r.name : "" }]
      : [];
  });
}

/**
 * The option auto-approve may pick — iOS `PermissionOptionItem.allowOnceOption`:
 * `allow_once`, else the first choice that is neither a reject nor
 * `allow_always`. Null means leave it to a person: permanently changing the
 * agent's permissions is never the toggle's call.
 */
export function allowOnceOption(options: ReadonlyArray<PermissionOption>): PermissionOption | null {
  return (
    options.find((o) => o.kind === "allow_once") ??
    options.find((o) => !o.kind.startsWith("reject") && o.kind !== "allow_always") ??
    null
  );
}

/** Per-session, this-device-only toggle (iOS `Session.autoApprovePermissions`). */
export function autoApproveStorageKey(sessionId: string): string {
  return `teamclu.autoApprovePermissions.${sessionId}`;
}
