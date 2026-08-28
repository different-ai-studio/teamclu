import { getCurrentWindow } from "@tauri-apps/api/window";
import { appDisplayName } from "@/lib/build-config";
import { notificationService } from "@/lib/notification-service";
import { shouldAutoAllowSessionPermissions } from "@/lib/session-permission-mode";
import { replyAcpPermission } from "@/lib/teamclu/reply-acp-permission";
import { wasPermissionRecentlyResolved } from "@/lib/teamclu/handle-session-event-permission-resolved";
import type { StreamingPermissionRequest } from "@/stores/v2-streaming-store";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { useCurrentTeamStore } from "@/stores/current-team";
import { useSessionListStore } from "@/stores/session-list-store";
import { useSessionSelectionStore } from "@/stores/session-selection-store";

const inFlightRequestIds = new Set<string>();
const osNotifiedRequestIds = new Set<string>();

function requesterActorIdFromRequest(request: StreamingPermissionRequest): string {
  return (
    request.requesterActorId?.trim() ||
    request.params?.requester_actor_id?.trim() ||
    ""
  );
}

/** Interactive / auto-allow allowed when legacy (empty) or current member is requester. */
export function canCurrentMemberActOnPermission(
  request: StreamingPermissionRequest,
  currentMemberId?: string | null,
): boolean {
  const requester = requesterActorIdFromRequest(request);
  if (!requester) return true; // legacy daemon
  const me = (currentMemberId ?? useCurrentTeamStore.getState().currentMember?.id ?? "").trim();
  return Boolean(me) && me === requester;
}

function sendAcpPermissionOsBanner(
  sessionId: string,
  request: StreamingPermissionRequest,
): void {
  const requestId = request.requestId?.trim();
  if (!requestId || osNotifiedRequestIds.has(requestId)) return;
  osNotifiedRequestIds.add(requestId);

  const sessionTitle =
    useSessionListStore.getState().rows.find((r) => r.id === sessionId)?.title ||
    "Session";
  const toolLabel = request.toolName?.trim() || request.description?.trim() || "tool";

  console.info("[notify-diag] acp-permission:os-notify", { sessionId, requestId, toolLabel });

  void notificationService
    .send(
      "action_required",
      `${appDisplayName} - Authorization required`,
      `${sessionTitle} \u2014 ${toolLabel}`,
      sessionId,
      async () => {
        try {
          await useSessionSelectionStore.getState().setActiveSession(sessionId);
          const appWindow = getCurrentWindow();
          await appWindow.setFocus();
          await appWindow.unminimize();
        } catch (err) {
          console.warn("[notify-diag] acp-permission:click-focus-failed", err);
        }
      },
    )
    .catch((err) => {
      osNotifiedRequestIds.delete(requestId);
      console.warn("[notify-diag] acp-permission:os-notify-failed", err);
    });
}

export async function handleAcpPermissionRequest(args: {
  sessionId: string;
  agentActorId: string;
  request: StreamingPermissionRequest;
}): Promise<void> {
  const requestId = args.request.requestId?.trim() ?? "";
  console.info("[notify-diag] acp-permission:received", {
    sessionId: args.sessionId,
    agentActorId: args.agentActorId,
    requestId,
    toolName: args.request.toolName ?? null,
  });

  if (!requestId) {
    console.warn("[notify-diag] acp-permission:skipped", { reason: "empty_request_id" });
    console.warn("[permission] empty requestId, ignoring permissionRequest");
    return;
  }

  if (wasPermissionRecentlyResolved(requestId)) {
    console.info("[notify-diag] acp-permission:skipped", { reason: "recently_resolved", requestId });
    return;
  }

  if (inFlightRequestIds.has(requestId)) {
    console.info("[notify-diag] acp-permission:skipped", { reason: "in_flight", requestId });
    return;
  }

  const store = useV2StreamingStore.getState();
  const normalized: StreamingPermissionRequest = {
    ...args.request,
    requestId,
    requesterActorId:
      args.request.requesterActorId?.trim() ||
      args.request.params?.requester_actor_id?.trim() ||
      undefined,
  };

  const writePending = (notifyOs: boolean) => {
    console.info("[notify-diag] acp-permission:pending-stored", {
      sessionId: args.sessionId,
      agentActorId: args.agentActorId,
      requestId,
      osNotifyWired: notifyOs,
    });
    store.setPermissionRequest(args.sessionId, args.agentActorId, normalized);
    if (notifyOs) {
      sendAcpPermissionOsBanner(args.sessionId, normalized);
    }
  };

  const canAct = canCurrentMemberActOnPermission(normalized);

  // Bystander with stamped requester: still store pending for waiting banner,
  // but never auto-allow or show interactive controls (UI filters separately).
  if (!canAct) {
    console.info("[notify-diag] acp-permission:skipped", {
      reason: "bystander",
      requestId,
      requesterActorId: requesterActorIdFromRequest(normalized) || null,
    });
    writePending(false);
    return;
  }

  if (!shouldAutoAllowSessionPermissions(args.sessionId)) {
    writePending(true);
    return;
  }

  console.info("[notify-diag] acp-permission:auto-allow", { sessionId: args.sessionId, requestId });
  inFlightRequestIds.add(requestId);
  try {
    await replyAcpPermission({
      sessionId: args.sessionId,
      agentActorId: args.agentActorId,
      requestId,
      decision: "allow",
    });
  } catch (err) {
    console.error("[notify-diag] acp-permission:auto-allow-failed", { requestId, err });
    console.error("[permission] session auto-allow failed", err);
    writePending(true);
  } finally {
    inFlightRequestIds.delete(requestId);
  }
}

/** Test helper */
export function resetAcpPermissionInFlightForTests(): void {
  inFlightRequestIds.clear();
  osNotifiedRequestIds.clear();
}
