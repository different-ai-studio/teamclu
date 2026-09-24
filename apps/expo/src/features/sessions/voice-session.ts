/**
 * The voice tab's take-to-session flow, ported from iOS #1557
 * (`VoiceCaptureView` + `VoiceSessionStarter` + the `RootTabView` wiring).
 *
 * Kept free of React Native so vitest can drive it: the reducer is the screen's
 * phase machine, `resolveVoiceTarget` decides who the take goes to, and
 * `startVoiceSession` creates the session through the same
 * `startSessionWithAgents` the New Session sheet uses.
 */

import type { Actor } from "../actors/actor-types";
import type { ConnectedAgent } from "../actors/connected-agent-types";
import {
  resolveAgentRuntimeStartPlans,
  type RuntimeStartAgent,
  type RuntimeStartWorkspace,
} from "./runtime-start";
import {
  deriveSessionTitle,
  startSessionWithAgents,
  type StartSessionDeps,
} from "./start-session";

// ---------------------------------------------------------------------------
// Phase machine
// ---------------------------------------------------------------------------

export type VoicePhase =
  /** Between opening the screen and the recognizer actually listening. */
  | "preparing"
  | "recording"
  /** The take is in, but there is no usable default agent — the picker is up. */
  | "awaitingAgent"
  /** The take is in; the target is being resolved and the session created. */
  | "startingSession"
  /** Terminal: the session exists, the screen navigates into it. */
  | "done"
  /** Terminal: the user backed out. */
  | "cancelled"
  /** Terminal until the user dismisses: nothing was created. */
  | "failed";

export type VoiceCaptureError =
  | { kind: "emptyTranscript" }
  | { kind: "permissionDenied" }
  | { kind: "noAgents" }
  | { kind: "notReady" }
  | { kind: "message"; message: string };

export type VoiceCaptureState = {
  phase: VoicePhase;
  /** The final transcript once the take is in; "" while recording. */
  transcript: string;
  /** Offered in the picker; only meaningful in `awaitingAgent`. */
  pickableAgents: ConnectedAgent[];
  error: VoiceCaptureError | null;
  sessionId: string | null;
};

export type VoiceCaptureEvent =
  | { type: "recordingStarted" }
  | { type: "stopped"; transcript: string }
  | { type: "needsPick"; agents: ConnectedAgent[] }
  | { type: "agentPicked" }
  | { type: "sessionStarted"; sessionId: string }
  | { type: "failed"; error: VoiceCaptureError }
  | { type: "cancel" };

export const initialVoiceCaptureState: VoiceCaptureState = {
  phase: "preparing",
  transcript: "",
  pickableAgents: [],
  error: null,
  sessionId: null,
};

export function isTerminalVoicePhase(phase: VoicePhase): boolean {
  return phase === "done" || phase === "cancelled" || phase === "failed";
}

/**
 * Pure transition function. Events that arrive in a phase that cannot take
 * them are ignored — most importantly async results landing after the user
 * cancelled, which must not resurrect the flow or navigate anywhere.
 */
export function voiceCaptureReducer(
  state: VoiceCaptureState,
  event: VoiceCaptureEvent,
): VoiceCaptureState {
  if (isTerminalVoicePhase(state.phase)) return state;

  switch (event.type) {
    case "recordingStarted":
      return state.phase === "preparing" ? { ...state, phase: "recording" } : state;

    case "stopped": {
      if (state.phase !== "recording" && state.phase !== "preparing") return state;
      const transcript = event.transcript.trim();
      if (!transcript) {
        return { ...state, phase: "failed", transcript: "", error: { kind: "emptyTranscript" } };
      }
      return { ...state, phase: "startingSession", transcript };
    }

    case "needsPick":
      if (state.phase !== "startingSession") return state;
      return { ...state, phase: "awaitingAgent", pickableAgents: event.agents };

    case "agentPicked":
      if (state.phase !== "awaitingAgent") return state;
      return { ...state, phase: "startingSession" };

    case "sessionStarted":
      if (state.phase !== "startingSession") return state;
      return { ...state, phase: "done", sessionId: event.sessionId };

    case "failed":
      return { ...state, phase: "failed", error: event.error };

    case "cancel":
      return { ...state, phase: "cancelled" };
  }
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

export type VoiceTarget =
  | { kind: "agent"; agent: ConnectedAgent }
  /** No usable default — ask the user; `agents` is never empty. */
  | { kind: "needsPick"; agents: ConnectedAgent[] }
  | { kind: "noAgents" };

/**
 * Who the take goes to. A default pointing at an agent the viewer can no
 * longer reach is as good as no default, so it falls through to the picker —
 * whose choice then overwrites the stale pointer.
 */
export function resolveVoiceTarget(args: {
  agents: ReadonlyArray<ConnectedAgent>;
  effectiveDefaultAgentId: string | null;
}): VoiceTarget {
  if (args.agents.length === 0) return { kind: "noAgents" };
  const match = args.effectiveDefaultAgentId
    ? args.agents.find((agent) => agent.agentId === args.effectiveDefaultAgentId)
    : undefined;
  if (match) return { kind: "agent", agent: match };
  return { kind: "needsPick", agents: [...args.agents] };
}

// ---------------------------------------------------------------------------
// Session creation
// ---------------------------------------------------------------------------

/**
 * The runtime-start view of an agent. The connected-agents row carries its
 * backend types; the directory row (when loaded) adds its default workspace.
 */
export function voiceRuntimeAgent(
  agent: ConnectedAgent,
  actor: Pick<Actor, "defaultWorkspaceId"> | null | undefined,
): RuntimeStartAgent {
  return {
    actorId: agent.agentId,
    displayName: agent.displayName,
    agentTypes: agent.agentTypes,
    defaultAgentType: agent.defaultAgentType,
    defaultWorkspaceId: actor?.defaultWorkspaceId ?? null,
  };
}

export class VoiceSessionError extends Error {
  constructor(readonly error: VoiceCaptureError) {
    super(error.kind === "message" ? error.message : error.kind);
    this.name = "VoiceSessionError";
  }
}

/**
 * Stricter than the New Session sheet: a voice take always addresses a single
 * agent, so a missing runtime RPC (MQTT down) is an error rather than a quiet
 * fall back to a human-only session.
 */
export async function startVoiceSession(
  deps: StartSessionDeps,
  input: {
    teamId: string;
    memberActorId: string;
    transcript: string;
    agent: RuntimeStartAgent;
    connectedAgentIds: ReadonlyArray<string>;
    workspaces: ReadonlyArray<RuntimeStartWorkspace>;
    fallbackTitle: string;
  },
): Promise<string> {
  const prompt = input.transcript.trim();
  if (!prompt) throw new VoiceSessionError({ kind: "emptyTranscript" });
  if (!deps.runtimeRpc) throw new VoiceSessionError({ kind: "notReady" });

  // Throws (offline daemon, no workspace) before anything is created.
  const runtimePlans = resolveAgentRuntimeStartPlans({
    agents: [input.agent],
    connectedAgents: input.connectedAgentIds.map((agentId) => ({ agentId })),
    workspaces: [...input.workspaces],
  });

  const agentId = input.agent.actorId;
  return startSessionWithAgents(
    deps,
    {
      teamId: input.teamId,
      memberActorId: input.memberActorId,
      title: deriveSessionTitle(prompt, input.fallbackTitle),
      message: prompt,
      primaryAgentActorId: agentId,
      ideaId: null,
      collaboratorActorIds: [agentId],
      mentionActorIds: [agentId],
      runtimePlans,
    },
  );
}

// ---------------------------------------------------------------------------
// Presentation arithmetic
// ---------------------------------------------------------------------------

/** `mm:ss` for the elapsed readout above the meter. */
export function formatVoiceClock(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/** 0 at the edges, 1 in the middle — the meter's spindle silhouette. */
export function voiceMeterBell(index: number, barCount: number): number {
  return Math.sin((index / Math.max(barCount - 1, 1)) * Math.PI);
}

/**
 * Height of one bar in the full-screen level meter — iOS `VoiceLevelMeter`
 * arithmetic: a travelling sine scaled by the live level, so silence still
 * pulses gently and speech swings wide.
 */
export function voiceMeterBarHeight(args: {
  index: number;
  barCount: number;
  level: number;
  time: number;
  height: number;
}): number {
  const l = Math.max(0, Math.min(1, args.level));
  const wave = (Math.sin(args.time * 5 + args.index * 0.55) + 1) / 2;
  const swing = voiceMeterBell(args.index, args.barCount) * (0.35 + 0.65 * wave) * (0.2 + 0.8 * l);
  const normalized = Math.min(1, 0.06 + swing);
  return Math.max(4, normalized * args.height);
}
