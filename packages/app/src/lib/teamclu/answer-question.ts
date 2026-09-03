import { mqttPublish } from "@/lib/mqtt/mqtt-bridge";
import {
  resolvePermissionCommandTarget,
  runtimeTargetsForSession,
} from "@/lib/agent/runtime-state-resolve";
import { sessionFlowError, sessionFlowLog } from "@/lib/session/session-flow-log";
import { useCurrentTeamStore } from "@/stores/current-team";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";
import { createRuntimeCommandSender } from "@/lib/teamclu/runtime-command";
import { runtimeCommand } from "@/lib/daemon/teamclu-rpc";


/**
 * Send the user's answers (or a rejection) for an opencode `question` tool
 * request. Target resolution mirrors permission replies: session participants
 * → runtime rows → live MQTT retains.
 */
export async function answerAcpQuestion(args: {
  sessionId: string;
  agentActorId: string;
  requestId: string;
  /** `[[selected labels], ...]` — one array per question, in order. */
  answers: string[][];
  reject?: boolean;
}): Promise<void> {
  const teamId = useCurrentTeamStore.getState().team?.id?.trim();
  if (!teamId) throw new Error("No active team");
  const senderActorId = useCurrentTeamStore.getState().currentMember?.id?.trim() ?? "";

  // The participant lookup that used to live here only existed to narrow
  // `listRuntimeTargetsForSession`. With targets read off the retain there is
  // nothing to narrow, so this is one fewer network round trip per command.

  // Straight off the retain: one attachment per session, no cloud round trip
  // and nothing stale to choose between.
  const sessionRuntimeRows = runtimeTargetsForSession(
    args.sessionId,
    useRuntimeStateStore.getState().byRuntimeId,
  );

  const target = resolvePermissionCommandTarget({
    agentActorId: args.agentActorId,
    sessionRuntimeRows,
    byRuntimeId: useRuntimeStateStore.getState().byRuntimeId,
  });
  if (!target) {
    throw new Error("Could not resolve agent runtime for question answer");
  }

  const peerId = `teamclu-desktop-${(senderActorId || "anon").slice(0, 8)}`;
  const sender = createRuntimeCommandSender({
    mqtt: { publish: mqttPublish },
    // Session-addressed RPC; on transport failure the sender retries once
    // then publishes to the spawn-keyed commands topic (issue #783).
    rpc: ({ targetActorId, sessionId: sid, envelope }) =>
      runtimeCommand({ targetActorId, sessionId: sid, envelope }),
    teamId,
    peerId,
    senderActorId,
  });

  try {
    await sender.sendAnswerQuestion({
      targetActorId: target.actorId,
      runtimeId: target.runtimeId,
      sessionId: args.sessionId,
      requestId: args.requestId,
      answers: args.answers,
      reject: args.reject,
    });
  } catch (error) {
    sessionFlowError("question.answer.failed", error, {
      sessionId: args.sessionId,
      requestId: args.requestId,
      runtimeId: target.runtimeId,
    });
    throw error;
  }
  sessionFlowLog("question.answer.ok", {
    sessionId: args.sessionId,
    requestId: args.requestId,
    reject: !!args.reject,
    runtimeId: target.runtimeId,
  });
}
