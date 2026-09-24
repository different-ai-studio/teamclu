import { create } from "@bufbuild/protobuf";
import {
  AcpAnswerQuestionSchema,
  AcpCancelSchema,
  AcpCommandSchema,
  AcpDenyPermissionSchema,
  AcpGrantPermissionSchema,
  AcpRequestTurnHistorySchema,
  RuntimeCommandEnvelopeSchema,
} from "@teamclu/app/proto/amux_pb";
import type { AcpCommand } from "@teamclu/app/proto/amux_pb";

import type { ConnectedAgent } from "../../features/actors/connected-agent-types";
import { uuidV4 } from "../uuid";
import type { RuntimeRpcClient } from "./runtime-rpc";

/**
 * ACP commands to an agent, addressed by (actor, session) over the
 * `runtime_command` RPC — the daemon resolves the session to whichever
 * attachment serves it. Mirrors iOS `TeamcluService.runtimeCommandRpc`.
 *
 * These used to be published to `{actor}/runtime/{runtime_id}/commands`, which
 * needed a runtime id the daemon no longer publishes (ADR-0004) and never
 * answered, so a dropped command looked like a sent one.
 */
type RuntimeCommandSenderDeps = {
  rpc: Pick<RuntimeRpcClient, "runtimeCommand">;
  peerId: string;
  senderActorId?: string | null;
  commandId?: () => string;
  nowSeconds?: () => number;
};

type Target = {
  targetActorId: string;
  sessionId: string;
};

export type RuntimePermissionResponseInput = Target & {
  requestId: string;
  granted: boolean;
  optionId?: string;
};

export type RuntimeAnswerQuestionInput = Target & {
  requestId: string;
  /** One array of selected labels per question, in order. Ignored when rejecting. */
  answers: ReadonlyArray<ReadonlyArray<string>>;
  reject?: boolean;
};

export type RuntimeRequestTurnHistoryInput = Target & {
  turnId: string;
  requestId?: string;
};

export type RuntimeCommandSender = {
  sendPermissionResponse: (input: RuntimePermissionResponseInput) => Promise<void>;
  /** Answer (or reject) an agent `question` tool request. */
  sendAnswerQuestion: (input: RuntimeAnswerQuestionInput) => Promise<void>;
  /**
   * Ask the daemon to replay a turn's history so an expanded turn shows the
   * full event list rather than only what this device happened to stream.
   */
  sendRequestTurnHistory: (input: RuntimeRequestTurnHistoryInput) => Promise<void>;
  /** Interrupt the agent's current turn in this session (iOS `interruptAgent`). */
  sendCancel: (input: Target) => Promise<void>;
};

/** Thrown when the daemon answered but holds no attachment for the session. */
export class NotDispatchedError extends Error {
  constructor() {
    super("The agent isn't running in this session.");
    this.name = "NotDispatchedError";
  }
}

export type PermissionRuntimeTarget = {
  agentId: string;
  actorId: string;
};

function required(value: string | null | undefined, label: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

export function createRuntimeCommandSender(
  deps: RuntimeCommandSenderDeps,
): RuntimeCommandSender {
  async function send(target: Target, acpCommand: AcpCommand): Promise<void> {
    const targetActorId = required(target.targetActorId, "target actor id");
    const sessionId = required(target.sessionId, "session id");
    const peerId = required(deps.peerId, "peer id");
    const envelope = create(RuntimeCommandEnvelopeSchema, {
      // Logging only — the daemon routes by (actor, session), not by this.
      runtimeId: `${targetActorId}::${sessionId}`,
      actorId: targetActorId,
      peerId,
      commandId: deps.commandId?.() ?? uuidV4(),
      timestamp: BigInt(Math.floor(deps.nowSeconds?.() ?? Date.now() / 1000)),
      senderActorId: deps.senderActorId?.trim() ?? "",
      acpCommand,
    });
    const { dispatched } = await deps.rpc.runtimeCommand({ targetActorId, sessionId, envelope });
    if (!dispatched) throw new NotDispatchedError();
  }

  return {
    async sendPermissionResponse(input) {
      const requestId = required(input.requestId, "request id");
      const acpCommand = input.granted
        ? create(AcpCommandSchema, {
            command: {
              case: "grantPermission",
              value: create(AcpGrantPermissionSchema, {
                requestId,
                optionId: input.optionId?.trim() ?? "",
              }),
            },
          })
        : create(AcpCommandSchema, {
            command: {
              case: "denyPermission",
              value: create(AcpDenyPermissionSchema, { requestId }),
            },
          });
      await send(input, acpCommand);
    },

    async sendAnswerQuestion(input) {
      const requestId = required(input.requestId, "request id");
      const reject = input.reject === true;
      await send(
        input,
        create(AcpCommandSchema, {
          command: {
            case: "answerQuestion",
            value: create(AcpAnswerQuestionSchema, {
              requestId,
              // The daemon ignores answers when rejecting; send an empty list
              // rather than a half-filled one so the payload can't mislead.
              answersJson: JSON.stringify(reject ? [] : input.answers),
              reject,
            }),
          },
        }),
      );
    },

    async sendRequestTurnHistory(input) {
      const turnId = required(input.turnId, "turn id");
      await send(
        input,
        create(AcpCommandSchema, {
          command: {
            case: "requestTurnHistory",
            value: create(AcpRequestTurnHistorySchema, {
              turnId,
              requestId: input.requestId?.trim() || uuidV4(),
            }),
          },
        }),
      );
    },

    async sendCancel(input) {
      await send(
        input,
        create(AcpCommandSchema, {
          command: { case: "cancel", value: create(AcpCancelSchema, {}) },
        }),
      );
    },
  };
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Which agent a permission reply / answer / history request goes to: the agent
 * that asked if it's a connected participant, else the first connected agent
 * participant. No runtime lookup — the daemon resolves the session itself.
 */
export function resolvePermissionRuntimeTarget(args: {
  requestingActorId?: string | null;
  agentParticipantIds: ReadonlyArray<string>;
  connectedAgents: ReadonlyArray<Pick<ConnectedAgent, "agentId">>;
}): PermissionRuntimeTarget | null {
  const agentParticipantIds = unique(
    args.agentParticipantIds.map((id) => id.trim()).filter(Boolean),
  );
  if (agentParticipantIds.length === 0) return null;

  const participantSet = new Set(agentParticipantIds);
  const candidates = unique(
    [args.requestingActorId?.trim() ?? "", ...agentParticipantIds].filter(
      (id) => id && participantSet.has(id),
    ),
  );

  // Only route to agents we know are connected, so a reply doesn't wait out
  // the RPC timeout against an offline daemon.
  const connectedAgentIds = new Set(
    args.connectedAgents.map((a) => a.agentId).filter(Boolean),
  );
  const agentId = candidates.find((id) => connectedAgentIds.has(id));
  return agentId ? { agentId, actorId: agentId } : null;
}
