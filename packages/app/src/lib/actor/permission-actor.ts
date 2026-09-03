import type { PendingPermissionEntry } from "@/stores/session-types";

const ACP_ACTOR_METADATA_KEY = "_acp_agent_actor_id";

/** Actor that owns an ACP live-stream permission request, when known. */
function resolvePermissionActorId(
  entry: PendingPermissionEntry,
): string | null {
  const metadata = entry.permission.metadata as Record<string, string> | undefined;
  const actorId = metadata?.[ACP_ACTOR_METADATA_KEY];
  return typeof actorId === "string" && actorId.trim().length > 0
    ? actorId.trim()
    : null;
}

export function resolveApprovalAnchorActorId(
  entry: PendingPermissionEntry | null,
  streamingActorIds: ReadonlyArray<string>,
): string | null {
  if (!entry || streamingActorIds.length === 0) return null;
  const permActor = resolvePermissionActorId(entry);
  if (permActor && streamingActorIds.includes(permActor)) {
    return permActor;
  }
  return streamingActorIds[0] ?? null;
}
