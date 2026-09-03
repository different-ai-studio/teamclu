import { discardPendingStreamReply } from "@/lib/stream/live-agent-stream";
import { mqttPublish } from "@/lib/mqtt/mqtt-bridge";
import {
  resolvePermissionCommandTarget,
  runtimeTargetsForSession,
} from "@/lib/agent/runtime-state-resolve";
import { sessionFlowError, sessionFlowLog } from "@/lib/session/session-flow-log";
import { logStreamToolDiag } from "@/lib/diagnostics/stream-tool-diag";
import { createRuntimeCommandSender } from "@/lib/teamclu/runtime-command";
import { runtimeCommand } from "@/lib/daemon/teamclu-rpc";
import { useCurrentTeamStore } from "@/stores/current-team";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";


function cleanupLocalAgentStream(sessionId: string, agentActorId: string): void {
  discardPendingStreamReply(sessionId, agentActorId);
  logStreamToolDiag("interrupt.cleanup", { sessionId, agentActorId });
  useV2StreamingStore.getState().finishSessionActor(sessionId, agentActorId, {
    reason: "interrupt",
  });
}

export async function interruptAgentActor(args: {
  sessionId: string;
  agentActorId: string;
}): Promise<void> {
  const sessionId = args.sessionId.trim();
  const agentActorId = args.agentActorId.trim();
  if (!sessionId || !agentActorId) {
    throw new Error("Session id and agent actor id are required");
  }

  const teamId = useCurrentTeamStore.getState().team?.id?.trim();
  if (!teamId) throw new Error("No active team");

  const senderActorId = useCurrentTeamStore.getState().currentMember?.id?.trim() ?? "";

  // Show stopping UI immediately — session-scoped resolve may take a Cloud API
  // round trip before cancel is published.
  useV2StreamingStore.getState().markInterruptedFlushPending(sessionId, agentActorId);

  // Interrupt targeting is deliberately session-scoped only. A single local
  // agent can run a distinct runtime per session, so we must resolve the
  // runtime that belongs to THIS session before cancelling — never a "latest
  // live retain for the agent" guess, which can cancel another session's turn.
  // The participant lookup that used to live here only existed to narrow
  // `listRuntimeTargetsForSession`. With targets read off the retain there is
  // nothing to narrow, so this is one fewer network round trip per command.

  // Straight off the retain: one attachment per session, no cloud round trip
  // and nothing stale to choose between.
  const sessionRuntimeRows = runtimeTargetsForSession(
    sessionId,
    useRuntimeStateStore.getState().byRuntimeId,
  );

  const byRuntimeId = useRuntimeStateStore.getState().byRuntimeId;
  const target = resolvePermissionCommandTarget({
    agentActorId,
    sessionRuntimeRows,
    byRuntimeId,
  });

  // Prefer (actor, session) RPC even when retain is missing — the owning
  // daemon resolves the live attachment by session_id. Requiring retain here
  // blocked cross-actor interrupt when the local client had no copy of the
  // remote agent's retain.
  const targetActorId = target?.actorId ?? agentActorId;
  const runtimeId = target?.runtimeId ?? sessionId;

  sessionFlowLog("interrupt.begin", {
    sessionId,
    agentActorId,
    targetActorId,
    runtimeId,
    sessionRuntimeId:
      sessionRuntimeRows.find((row) => row.agent_id?.trim() === agentActorId)?.runtime_id ??
      null,
  });

  const peerId = `teamclu-desktop-${(senderActorId || "anon").slice(0, 8)}`;
  const sender = createRuntimeCommandSender({
    mqtt: { publish: mqttPublish },
    // Session-addressed dispatch with a delivery receipt. No silent legacy
    // topic fallback — that path mis-addresses by session UUID as a spawn key.
    rpc: ({ targetActorId: actor, sessionId: sid, envelope }) =>
      runtimeCommand({ targetActorId: actor, sessionId: sid, envelope }),
    teamId,
    peerId,
    senderActorId,
  });

  try {
    await sender.sendCancel({
      targetActorId,
      runtimeId,
      sessionId,
    });
  } catch (error) {
    useV2StreamingStore.getState().clearInterruptedFlushPending(sessionId, agentActorId);
    cleanupLocalAgentStream(sessionId, agentActorId);
    sessionFlowError("interrupt.failed", error, {
      sessionId,
      agentActorId,
      runtimeId,
    });
    throw error;
  }

  // Wait for daemon Active→Idle + message.created; App.tsx finalizes the
  // partial turn via flushPendingStreamReply on statusChange.
  // interruptedFlushPending was marked at the start of this function.

  sessionFlowLog("interrupt.ok", {
    sessionId,
    agentActorId,
    runtimeId,
  });
}

