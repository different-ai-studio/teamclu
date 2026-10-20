import { fromBinary } from "@bufbuild/protobuf";
import { AgentStatus, EnvelopeSchema, type AcpEvent, type SessionEvent } from "@teamclu/app/proto/amux_pb";
import { LiveEventEnvelopeSchema } from "@teamclu/app/proto/teamclu_pb";

/**
 * The session list's activity dot — iOS `SessionLiveActivity` (#1567): is an
 * agent working in this session, or waiting on a person? Read off the
 * session's own `amux/{team}/session/{id}/live` stream, because the retained
 * actor state never republishes the Active↔Idle flips inside a session.
 */
export type SessionLiveActivity = "quiet" | "running" | "needsAttention";

export type SessionLiveSignal =
  | { kind: "turnStarted" }
  | { kind: "turnEnded" }
  | { kind: "progress" }
  | { kind: "attentionRequested"; id: string }
  | { kind: "attentionResolved"; id: string }
  | { kind: "idleChatter" };

export type SessionActivityState = {
  isRunning: boolean;
  /** Open permission / question ids — two can be pending at once. */
  pendingRequestIds: ReadonlySet<string>;
  lastSignalAt: number;
};

export function initialActivityState(now = 0): SessionActivityState {
  return { isRunning: false, pendingRequestIds: new Set(), lastSignalAt: now };
}

export function activityOf(state: SessionActivityState | undefined): SessionLiveActivity {
  if (!state) return "quiet";
  if (state.pendingRequestIds.size > 0) return "needsAttention";
  return state.isRunning ? "running" : "quiet";
}

export function applySignal(
  state: SessionActivityState,
  signal: SessionLiveSignal,
  now: number,
): SessionActivityState {
  const next: SessionActivityState = { ...state, lastSignalAt: now };
  switch (signal.kind) {
    case "turnStarted":
    case "progress":
      return { ...next, isRunning: true };
    case "turnEnded":
      return { ...next, isRunning: false };
    case "attentionRequested": {
      if (!signal.id) return next;
      const pending = new Set(state.pendingRequestIds);
      pending.add(signal.id);
      // A request only exists inside an open turn, which resumes once it's
      // answered — so resolving goes back to green, not grey.
      return { ...next, pendingRequestIds: pending, isRunning: true };
    }
    case "attentionResolved": {
      if (!signal.id) return next;
      const pending = new Set(state.pendingRequestIds);
      pending.delete(signal.id);
      return { ...next, pendingRequestIds: pending };
    }
    case "idleChatter":
      return next;
  }
}

/** Still worth holding the live subscription for. A pending request pins it. */
export function isHot(state: SessionActivityState, now: number, quietGraceMs: number): boolean {
  if (state.pendingRequestIds.size > 0 || state.isRunning) return true;
  return now - state.lastSignalAt < quietGraceMs;
}

/**
 * Drops a `running` flag whose turn never announced its end (daemon killed
 * mid-turn, phone backgrounded). Pending requests are exempt: silence is what
 * a blocked turn looks like.
 */
export function expireStaleRun(
  state: SessionActivityState,
  now: number,
  timeoutMs: number,
): SessionActivityState | null {
  if (!state.isRunning || state.pendingRequestIds.size > 0) return null;
  if (now - state.lastSignalAt < timeoutMs) return null;
  return { ...state, isRunning: false };
}

/**
 * One `session/live` payload → a dot signal. Null only when the envelope
 * itself fails to decode; an event we don't know is `idleChatter`, so a
 * daemon that starts publishing something new never strands the dot.
 */
export function decodeLiveSignal(payload: Uint8Array): SessionLiveSignal | null {
  let live;
  try {
    live = fromBinary(LiveEventEnvelopeSchema, payload);
  } catch {
    return null;
  }
  // `message.created` & co. are real traffic but say nothing about a turn;
  // the agent's own reply lands at turn *end*.
  if (live.eventType !== "acp.event") return { kind: "idleChatter" };
  let envelope;
  try {
    envelope = fromBinary(EnvelopeSchema, live.body);
  } catch {
    return null;
  }
  switch (envelope.payload.case) {
    case "acpEvent":
      return signalFromAcp(envelope.payload.value);
    case "sessionEvent":
      return signalFromSession(envelope.payload.value);
    default:
      return { kind: "idleChatter" };
  }
}

function signalFromAcp(acp: AcpEvent): SessionLiveSignal {
  const event = acp.event;
  switch (event.case) {
    case "statusChange":
      switch (event.value.newStatus) {
        case AgentStatus.ACTIVE:
          return { kind: "turnStarted" };
        case AgentStatus.IDLE:
        case AgentStatus.STOPPED:
        case AgentStatus.ERROR:
          return { kind: "turnEnded" };
        default:
          // Starting is the attachment spinning up, not a turn.
          return { kind: "idleChatter" };
      }
    case "permissionRequest":
      return { kind: "attentionRequested", id: event.value.requestId };
    case "raw": {
      const method = event.value.method;
      if (method !== "question_asked" && method !== "question_replied" && method !== "question_rejected") {
        return { kind: "idleChatter" };
      }
      const id = questionRequestId(event.value.jsonPayload);
      if (!id) return { kind: "idleChatter" };
      return method === "question_asked"
        ? { kind: "attentionRequested", id }
        : { kind: "attentionResolved", id };
    }
    case "output":
    case "thinking":
    case "toolUse":
    case "toolResult":
    case "planUpdate":
      return { kind: "progress" };
    default:
      return { kind: "idleChatter" };
  }
}

function signalFromSession(event: SessionEvent): SessionLiveSignal {
  switch (event.event.case) {
    case "permissionResolved":
      return { kind: "attentionResolved", id: event.event.value.requestId };
    case "promptAccepted":
      return { kind: "progress" };
    default:
      return { kind: "idleChatter" };
  }
}

/** `question_asked` keys the id as `id`; replies use `requestID`, falling back to `id`. */
export function questionRequestId(json: Uint8Array): string | null {
  try {
    const payload = JSON.parse(new TextDecoder().decode(json)) as Record<string, unknown>;
    const id = typeof payload.requestID === "string" ? payload.requestID : payload.id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}
