import { create, toBinary } from "@bufbuild/protobuf";
import {
  LiveEventEnvelopeSchema,
  MessageKind,
  MessageSchema,
  SessionMessageEnvelopeSchema,
  type Message,
  type LiveEventEnvelope,
} from "@teamclu/app/proto/teamclu_pb";
import {
  AgentStatus,
  type AcpEvent,
  type AcpPlanEntry,
} from "@teamclu/app/proto/amux_pb";

import { decodeLiveEvent } from "../../lib/teamclu/live-events";
import type { TeamMqttClient } from "../../lib/mqtt/team-mqtt";
import { uuidV4 } from "../../lib/uuid";
import type { Actor } from "../actors/actor-types";
import { setOutboxStatus, syncOutboxFromDao } from "./outbox-store";
import type { OutboxDao } from "./outbox-db";
import type { OutboxSender } from "./outbox-sender";
import { peekPendingAttachments, takePendingAttachments } from "./pending-attachments";
import {
  decodePendingQuestion,
  decodeQuestionRequestId,
  removePendingQuestion,
  upsertPendingQuestion,
  type PendingAcpQuestion,
} from "./pending-questions";
import { resolveMentionActorIdsForComposer } from "./session-mention-resolver";
import type { SessionDetailCache } from "./session-detail-cache";
import type { StreamingSnapshotStore } from "./streaming-snapshot";
import {
  buildSessionDetailState,
  type SessionDetailState,
  type SessionMessage,
  type SessionSummary,
  type StreamingBuffer,
  type TimelineEvent,
} from "./session-types";
import {
  reduceTimeline,
  emptyTimelineState,
  mergeNewestPage,
  type TimelineState,
} from "./timeline-reducer";
import type { createCloudSessionsApi } from "./cloud-api";

export type SessionDetailConnectionState = "connecting" | "connected" | "disconnected";

export type SessionDetailControllerState = {
  status: SessionDetailState["status"];
  session: SessionSummary | null;
  messages: SessionMessage[];
  errorMessage: string | null;
  connectionState: SessionDetailConnectionState;
  composerText: string;
  isSending: boolean;
  isRefreshing: boolean;
  sendErrorMessage: string | null;
  replyTarget: { messageId: string; content: string } | null;
  streamingByAgent: ReadonlyMap<string, StreamingBuffer>;
  /**
   * Unanswered opencode `question` prompts, oldest first. The composer is
   * replaced by the first entry until it is answered or rejected.
   */
  pendingQuestions: ReadonlyArray<PendingAcpQuestion>;
  /**
   * Whether the server reported a page older than the one loaded. False also
   * covers "we are already at the beginning of the session".
   */
  canLoadOlder: boolean;
  /** A back-scroll fetch is in flight. */
  isLoadingOlder: boolean;
};

type SessionsApi = ReturnType<typeof createCloudSessionsApi>;

/** iOS `runWatchdog`: a stream silent this long is treated as over. */
export const STALE_STREAM_TIMEOUT_MS = 90_000;

type SessionDetailControllerDeps = {
  /** Test seam for the stale-stream watchdog. */
  staleStreamTimeoutMs?: number;
  api: Pick<
    SessionsApi,
    | "getSession"
    | "insertOutgoingMessage"
    | "listMessagesPage"
    | "markSessionRead"
    | "resolveMemberActorId"
  >;
  currentMemberActorId: string | null;
  getAuth: () => Promise<{ accessToken: string | null; userId: string | null }>;
  getTeamActors?: () => ReadonlyArray<Actor>;
  mqtt: Pick<TeamMqttClient, "subscribe" | "publish" | "onConnectionState">;
  mqttUrl: string | null;
  sessionId: string;
  teamId: string;
  cache?: SessionDetailCache;
  outbox?: { sender: OutboxSender; dao: OutboxDao };
  /**
   * Partial-output store used across a suspend. Absent in tests that don't
   * exercise the lifecycle path.
   */
  streamingSnapshots?: StreamingSnapshotStore;
};

type SessionDetailController = {
  subscribe: (listener: () => void) => () => void;
  getState: () => SessionDetailControllerState;
  load: (options?: { preserveExisting?: boolean }) => Promise<void>;
  /**
   * Walk one page further back through the transcript. No-op once the server
   * stops reporting a cursor, or while a page is already in flight.
   */
  loadOlderMessages: () => Promise<void>;
  setComposerText: (value: string) => void;
  setReplyTarget: (target: { messageId: string; content: string } | null) => void;
  sendMessage: () => Promise<void>;
  /**
   * Drop a question locally once its answer has been published. The daemon also
   * emits `question_replied`/`question_rejected`, but a slow broker echo would
   * otherwise leave the answered card blocking the composer.
   */
  resolvePendingQuestion: (requestId: string) => void;
  /**
   * Persist the in-flight streaming buffers before the process is suspended.
   * Does not touch the live buffers or the MQTT subscription — if the process
   * survives, nothing changed; if it is reclaimed, the next launch restores
   * the partial text instead of an empty bubble.
   */
  flushStreamingForBackground: () => Promise<void>;
  /**
   * Counterpart to the above, called on the way back to the foreground. The
   * live buffers are authoritative again, so the snapshot is now stale.
   */
  discardBackgroundSnapshot: () => Promise<void>;
  dispose: () => Promise<void>;
};

const initialState: SessionDetailControllerState = {
  status: "loading",
  session: null,
  messages: [],
  errorMessage: null,
  connectionState: "disconnected",
  composerText: "",
  isSending: false,
  isRefreshing: false,
  sendErrorMessage: null,
  replyTarget: null,
  streamingByAgent: emptyTimelineState().streamingByAgent,
  pendingQuestions: [],
  canLoadOlder: false,
  isLoadingOlder: false,
};

function toIsoFromSeconds(value: bigint): string {
  return new Date(Number(value) * 1000).toISOString();
}

function liveEventCreatedAt(envelope: LiveEventEnvelope): string {
  return envelope.sentAt > BigInt(0)
    ? toIsoFromSeconds(envelope.sentAt)
    : new Date().toISOString();
}

function kindToString(kind: MessageKind): string {
  switch (kind) {
    case MessageKind.SYSTEM:
      return "system";
    case MessageKind.AGENT_THINKING:
      return "agent_thinking";
    case MessageKind.AGENT_TOOL_CALL:
      return "agent_tool_call";
    case MessageKind.AGENT_TOOL_RESULT:
      return "agent_tool_result";
    case MessageKind.AGENT_REPLY:
      return "agent_reply";
    case MessageKind.TEXT:
    default:
      return "text";
  }
}

function mapProtoMessage(message: Message, teamId: string): SessionMessage | null {
  if (!message.messageId || !message.sessionId) {
    return null;
  }

  return {
    content: message.content ?? "",
    createdAt: toIsoFromSeconds(message.createdAt),
    kind: kindToString(message.kind),
    messageId: message.messageId,
    metadata: null,
    model: message.model ?? "",
    replyToMessageId: message.replyToMessageId ?? "",
    senderActorId: message.senderActorId ?? "",
    sessionId: message.sessionId,
    teamId,
    turnId: message.turnId ?? "",
  };
}

function runtimeMessageId(
  envelope: LiveEventEnvelope,
  actorId: string,
  eventCase: string,
): string {
  const eventId = envelope.eventId || `${envelope.sentAt.toString()}:${eventCase}`;
  return `acp:${envelope.sessionId}:${actorId}:${eventId}`;
}

function planStatusPrefix(status: string): string {
  switch (status) {
    case "completed":
      return "[done]";
    case "in_progress":
      return "[wip]";
    case "cancelled":
      return "[cancelled]";
    case "pending":
    default:
      return "[todo]";
  }
}

function planUpdateText(entries: readonly AcpPlanEntry[]): string {
  return entries
    .map((entry) => `${planStatusPrefix(entry.status)} ${entry.content.trim()}`.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function createRuntimeMessage(input: {
  actorId: string;
  content: string;
  createdAt: string;
  envelope: LiveEventEnvelope;
  kind: string;
  metadata?: Record<string, unknown> | null;
  model?: string;
  teamId: string;
}): SessionMessage {
  return {
    content: input.content,
    createdAt: input.createdAt,
    kind: input.kind,
    messageId: runtimeMessageId(input.envelope, input.actorId, input.kind),
    metadata: input.metadata ?? null,
    model: input.model ?? "",
    replyToMessageId: "",
    senderActorId: input.actorId,
    sessionId: input.envelope.sessionId || "",
    teamId: input.teamId,
    turnId: "",
  };
}

function runtimeMessageFromAcpEvent(
  acpEvent: AcpEvent,
  envelope: LiveEventEnvelope,
  actorId: string,
  teamId: string,
): SessionMessage | null {
  const event = acpEvent.event;
  const createdAt = liveEventCreatedAt(envelope);
  switch (event.case) {
    case "thinking": {
      const content = event.value.text;
      if (!content) return null;
      return createRuntimeMessage({
        actorId,
        content,
        createdAt,
        envelope,
        kind: "agent_thinking",
        model: acpEvent.model,
        teamId,
      });
    }
    case "toolUse": {
      const params = event.value.params ?? {};
      const paramsText = Object.entries(params)
        .map(([key, value]) => `${key}: ${value}`)
        .join(", ");
      const content = [
        event.value.toolName || "Tool",
        event.value.description,
        paramsText ? `(${paramsText})` : "",
      ].filter(Boolean).join(" ");
      return createRuntimeMessage({
        actorId,
        content,
        createdAt,
        envelope,
        kind: "agent_tool_call",
        metadata: {
          tool_id: event.value.toolId,
          tool_kind: event.value.toolKind,
          tool_name: event.value.toolName,
          params,
        },
        teamId,
      });
    }
    case "toolResult": {
      return createRuntimeMessage({
        actorId,
        content: event.value.summary || (event.value.success ? "Tool completed" : "Tool failed"),
        createdAt,
        envelope,
        kind: "agent_tool_result",
        metadata: {
          success: event.value.success,
          tool_id: event.value.toolId,
        },
        teamId,
      });
    }
    case "error": {
      const content = [event.value.message, event.value.details].filter(Boolean).join("\n\n");
      return createRuntimeMessage({
        actorId,
        content: content || "Agent error",
        createdAt,
        envelope,
        kind: "agent_error",
        teamId,
      });
    }
    case "permissionRequest": {
      return createRuntimeMessage({
        actorId,
        content: event.value.description,
        createdAt,
        envelope,
        kind: "permission_request",
        metadata: {
          params: event.value.params ?? {},
          request_id: event.value.requestId,
          tool_id: event.value.requestId,
          tool_name: event.value.toolName,
          // The agent's own choices (allow once / always / reject). Dropped
          // before, so a reply could never name the option it picked.
          options: event.value.options.map((option) => ({
            id: option.optionId,
            kind: option.kind,
            name: option.name,
          })),
        },
        teamId,
      });
    }
    case "planUpdate": {
      const content = planUpdateText(event.value.entries);
      if (!content) return null;
      return createRuntimeMessage({
        actorId,
        content,
        createdAt,
        envelope,
        kind: "plan_update",
        teamId,
      });
    }
    default:
      return null;
  }
}

function nextStatusForMessages(
  session: SessionSummary | null,
  messages: SessionMessage[],
  fallback: SessionDetailControllerState["status"],
): SessionDetailControllerState["status"] {
  if (!session) {
    return fallback;
  }

  return messages.length > 0 ? "ready" : "empty";
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

function timelineFromMessages(
  messages: readonly SessionMessage[],
  streamingByAgent: ReadonlyMap<string, StreamingBuffer> = new Map(),
): TimelineState {
  let next: TimelineState = {
    messages: [],
    streamingByAgent: new Map(streamingByAgent),
  };
  for (const message of messages) {
    next = reduceTimeline(next, { kind: "messageCommitted", message });
  }
  return next;
}

export function createSessionDetailController(
  deps: SessionDetailControllerDeps,
): SessionDetailController {
  const listeners = new Set<() => void>();
  let state = initialState;
  /**
   * Whether MQTT has ever reached `connected` for this controller. Separates
   * the first connect (whose fetch is already in flight) from a genuine
   * reconnect, which has a gap to close.
   */
  let hasConnectedOnce = false;
  let timeline: TimelineState = emptyTimelineState();
  /**
   * Cursor to the page *before* the oldest one loaded, or null at the start of
   * the session. `/v1/sessions/:id/messages` walks backward: no cursor gives
   * the newest page, and `nextCursor` reaches older ones.
   */
  let olderCursor: string | null = null;
  /**
   * Set once a back-scroll has succeeded. A refresh fetches the newest page
   * again and reports the cursor just behind it — which is a page the user has
   * already read past — so after a walk back the cursor is left alone rather
   * than rewound.
   */
  let hasWalkedBack = false;
  let disposed = false;
  let unsubscribeSession: (() => void) | null = null;
  let cleanupConnectionStateListener: (() => void) | null = null;
  let loadToken = 0;

  function emit() {
    for (const listener of listeners) {
      listener();
    }
  }

  // Stale-run watchdog — iOS `SessionActivityState.expireStaleRun`. An agent
  // killed mid-turn (daemon crash, machine asleep, the idle status lost while
  // the phone was backgrounded) sends nothing more, and without this its card
  // said "replying" for the rest of the screen's life. Any change to a stream
  // re-arms its timer; silence for the whole window closes it, exactly as an
  // idle status would.
  const staleStreamTimers = new Map<string, { buffer: unknown; timer: ReturnType<typeof setTimeout> }>();
  function armStaleStreamWatchdog(next: TimelineState) {
    for (const [agentId, entry] of staleStreamTimers) {
      const buffer = next.streamingByAgent.get(agentId);
      if (!buffer || buffer.isComplete) {
        clearTimeout(entry.timer);
        staleStreamTimers.delete(agentId);
      }
    }
    for (const [agentId, buffer] of next.streamingByAgent) {
      if (buffer.isComplete) continue;
      const existing = staleStreamTimers.get(agentId);
      if (existing?.buffer === buffer) continue;
      if (existing) clearTimeout(existing.timer);
      const timer = setTimeout(() => {
        staleStreamTimers.delete(agentId);
        if (disposed) return;
        const current = timeline.streamingByAgent.get(agentId);
        if (current !== buffer || current.isComplete) return;
        publishTimelineState(
          reduceTimeline(timeline, {
            kind: "streamingDelta",
            agentId,
            messageId: current.messageId,
            messageKind: current.kind,
            deltaText: "",
            createdAt: new Date().toISOString(),
            isComplete: true,
            model: current.model,
          }),
        );
      }, deps.staleStreamTimeoutMs ?? STALE_STREAM_TIMEOUT_MS);
      staleStreamTimers.set(agentId, { buffer, timer });
    }
  }

  function setState(nextState: SessionDetailControllerState) {
    state = nextState;
    // Every path that shows a stream goes through here — including restored
    // background snapshots, which never pass `publishTimelineState` — so the
    // stale-stream watchdog is armed here rather than there.
    armStaleStreamWatchdog(timeline);
    emit();
  }

  function disconnectRealtime() {
    cleanupConnectionStateListener?.();
    cleanupConnectionStateListener = null;
    unsubscribeSession?.();
    unsubscribeSession = null;
  }

  async function resolveSenderActorId(): Promise<string> {
    if (deps.currentMemberActorId) {
      return deps.currentMemberActorId;
    }

    const auth = await deps.getAuth();
    if (!auth.userId) {
      throw new Error("无法读取当前用户信息。");
    }

    const resolved = await deps.api.resolveMemberActorId(deps.teamId, auth.userId);
    if (!resolved) {
      throw new Error("无法解析当前团队里的成员身份。");
    }

    return resolved;
  }

  /**
   * Coalesced write-behind for the timeline.
   *
   * Every timeline change routes through `publishTimelineState`, including the
   * ACP-driven ones — agent thinking, tool calls, tool results, plan updates.
   * Those used to reach React state and nothing else: the ACP branch returned
   * before the one `saveMessages` call further down, so an agent's whole trace
   * lived in memory and died with the process. iOS persists the same events
   * from its streaming path (`TimelineSwiftDataSync`), explicitly for crash
   * recovery.
   *
   * The cache is an AsyncStorage blob rewritten whole, so writing per event
   * would thrash it during a busy turn. Writes coalesce to one per interval,
   * with `flushTimelinePersist` for the moments that must not be lost.
   */
  const PERSIST_INTERVAL_MS = 1_000;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let persistPending = false;

  function writeTimelineNow() {
    persistPending = false;
    if (!deps.cache) return;
    void deps.cache.saveMessages(deps.sessionId, timeline.messages);
  }

  function scheduleTimelinePersist() {
    if (!deps.cache) return;
    persistPending = true;
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      if (persistPending) writeTimelineNow();
    }, PERSIST_INTERVAL_MS);
  }

  function flushTimelinePersist() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (persistPending) writeTimelineNow();
  }

  function publishTimelineState(next: TimelineState) {
    timeline = next;
    setState({
      ...state,
      messages: next.messages,
      streamingByAgent: next.streamingByAgent,
      status: nextStatusForMessages(state.session, next.messages, state.status),
    });
    scheduleTimelinePersist();
  }

  /**
   * OpenCode question events are control-plane state, not timeline rows: keep
   * them in-memory and let the composer surface the prompt (iOS does the same).
   * Returns true when the event was a question event and needs no further
   * timeline handling.
   */
  function applyQuestionRawEvent(method: string, payload: Uint8Array, actorId: string): boolean {
    if (
      method !== "question_asked" &&
      method !== "question_replied" &&
      method !== "question_rejected"
    ) {
      return false;
    }
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return true;
    }
    if (method === "question_asked") {
      const question = decodePendingQuestion(json, actorId);
      if (!question) return true;
      setState({
        ...state,
        pendingQuestions: upsertPendingQuestion(state.pendingQuestions, question),
      });
      return true;
    }
    const requestId = decodeQuestionRequestId(json);
    if (requestId) {
      setState({
        ...state,
        pendingQuestions: removePendingQuestion(state.pendingQuestions, requestId),
      });
    }
    return true;
  }

  function applyAcpEvent(acpEvent: AcpEvent, envelope: LiveEventEnvelope): boolean {
    const actorId = envelope.actorId;
    if (!actorId) return false;

    const event = acpEvent.event;
    const createdAt = liveEventCreatedAt(envelope);
    let next: TimelineState | null = null;

    if (
      event.case === "raw" &&
      applyQuestionRawEvent(event.value.method, event.value.jsonPayload, actorId)
    ) {
      return false;
    }

    if (event.case === "output") {
      const prev = timeline.streamingByAgent.get(actorId);
      const text = event.value.text ?? "";
      if (!prev && !text && !event.value.isComplete) {
        return false;
      }
      next = reduceTimeline(timeline, {
        kind: "streamingDelta",
        agentId: actorId,
        messageId: prev?.messageId ?? runtimeMessageId(envelope, actorId, "agent_reply"),
        messageKind: "agent_reply",
        deltaText: text,
        createdAt,
        isComplete: event.value.isComplete,
        model: acpEvent.model,
      });
    } else if (event.case === "statusChange") {
      if (event.value.newStatus !== AgentStatus.IDLE) {
        return false;
      }
      const prev = timeline.streamingByAgent.get(actorId);
      if (!prev || prev.isComplete) {
        return false;
      }
      next = reduceTimeline(timeline, {
        kind: "streamingDelta",
        agentId: actorId,
        messageId: prev.messageId,
        messageKind: prev.kind,
        deltaText: "",
        createdAt,
        isComplete: true,
        model: prev.model,
      });
    } else {
      const message = runtimeMessageFromAcpEvent(
        acpEvent,
        envelope,
        actorId,
        deps.teamId,
      );
      if (!message) {
        return false;
      }
      next = reduceTimeline(timeline, { kind: "messageCommitted", message });
    }

    if (next === timeline) {
      return false;
    }
    publishTimelineState(next);
    return true;
  }

  async function connectRealtime(_session: SessionSummary, currentToken: number) {
    if (disposed || currentToken !== loadToken) {
      return;
    }

    try {
      cleanupConnectionStateListener = deps.mqtt.onConnectionState((connectionState) => {
        if (disposed || currentToken !== loadToken) {
          return;
        }

        // Catch up on what was missed while the socket was down. The session's
        // `live` topic is not retained — only presence and runtime state are —
        // so anything published during the gap is simply not redelivered on
        // resubscribe, and the timeline would stay short a few messages until
        // the screen was reopened. iOS runs the same recovery on every
        // reconnect ("two-source recovery" in SessionDetailViewModel).
        //
        // Not on the first connect: the load that installed this listener is
        // already fetching.
        const wasDropped =
          state.connectionState === "disconnected" || state.connectionState === "connecting";
        const reconnected = connectionState === "connected" && wasDropped && hasConnectedOnce;
        if (connectionState === "connected") hasConnectedOnce = true;

        setState({
          ...state,
          connectionState,
        });

        if (reconnected) {
          void controller.load({ preserveExisting: true });
        }
      });

      const topic = `amux/${deps.teamId}/session/${deps.sessionId}/live`;
      unsubscribeSession = deps.mqtt.subscribe(topic, (payload) => {
        if (disposed || currentToken !== loadToken) {
          return;
        }

        const decoded = decodeLiveEvent(payload);
        if (!decoded) {
          return;
        }

        if (decoded.acpEvent) {
          applyAcpEvent(decoded.acpEvent, decoded.envelope);
          return;
        }

        if (!decoded.message) {
          return;
        }

        const nextMessage = mapProtoMessage(decoded.message, deps.teamId);
        if (!nextMessage) {
          return;
        }

        const event: TimelineEvent = { kind: "messageCommitted", message: nextMessage };
        const next = reduceTimeline(timeline, event);
        publishTimelineState(next);
        // A committed message ends a turn; land it now rather than waiting out
        // the coalescing window.
        flushTimelinePersist();

        // Live-update the read marker so the Sessions list stays clean
        // while the detail screen is open. We pass the senderActorId
        // through so a future receipts UI can resolve "who's read up
        // to where" without an extra lookup.
        if (
          deps.currentMemberActorId &&
          nextMessage.senderActorId !== deps.currentMemberActorId
        ) {
          void deps.api
            .markSessionRead(deps.sessionId, deps.currentMemberActorId, nextMessage.messageId)
            .catch(() => {
              // best-effort
            });
        }
      });

      // Closes the gap between the fetch above and this subscription. Merged
      // rather than folded through `mergeNewestPage`: a message published in
      // that window is an addition, and nothing here says a row that is absent
      // was deleted.
      const latest = await deps.api.listMessagesPage(deps.teamId, deps.sessionId);

      if (disposed || currentToken !== loadToken) {
        disconnectRealtime();
        return;
      }

      let next = timeline;
      for (const m of latest.items) {
        next = reduceTimeline(next, { kind: "messageCommitted", message: m });
      }
      timeline = next;

      setState({
        ...state,
        connectionState: "connected",
        messages: next.messages,
        streamingByAgent: next.streamingByAgent,
        status: nextStatusForMessages(state.session, next.messages, state.status),
      });
    } catch (error) {
      if (disposed || currentToken !== loadToken) {
        return;
      }

      console.warn(
        "MQTT realtime connect failed",
        error instanceof Error ? error.message : error,
      );
      setState({
        ...state,
        connectionState: "disconnected",
        sendErrorMessage: state.sendErrorMessage,
      });
    }
  }

  const controller: SessionDetailController = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState() {
      return state;
    },
    async load(options) {
      loadToken += 1;
      const currentToken = loadToken;
      const preserveExisting = options?.preserveExisting === true && state.session !== null;
      disconnectRealtime();

      if (preserveExisting) {
        setState({
          ...state,
          connectionState: "connecting",
          errorMessage: null,
          isRefreshing: true,
          sendErrorMessage: null,
        });
      } else {
        timeline = emptyTimelineState();
        olderCursor = null;
        hasWalkedBack = false;
        setState({
          ...state,
          status: "loading",
          session: null,
          messages: [],
          errorMessage: null,
          connectionState: "disconnected",
          isRefreshing: false,
          sendErrorMessage: null,
          streamingByAgent: timeline.streamingByAgent,
          canLoadOlder: false,
          isLoadingOlder: false,
        });
      }

      deps.outbox?.sender.start();

      // A snapshot only exists if the process was killed while streaming.
      // Restore before the timeline hydrate so a partial bubble is on screen
      // from the first paint, then let the daemon's real message replace it.
      const restoreSnapshot =
        deps.streamingSnapshots && !preserveExisting
          ? deps.streamingSnapshots.load(deps.sessionId).then((restored) => {
              if (disposed || currentToken !== loadToken || restored.size === 0) return;
              const merged = new Map(timeline.streamingByAgent);
              for (const [agentId, buffer] of restored) {
                // A live delta that already arrived is newer than anything on disk.
                if (!merged.has(agentId)) merged.set(agentId, buffer);
              }
              timeline = { ...timeline, streamingByAgent: merged };
              setState({ ...state, streamingByAgent: timeline.streamingByAgent });
            })
          : null;

      // Hydrate from disk first so the user sees the timeline immediately on
      // cold start. The network results below overlay on top once they land.
      const hydrateFromCache =
        deps.cache && !preserveExisting
          ? deps.cache.load(deps.sessionId).then((cached) => {
              if (disposed || currentToken !== loadToken || !cached) return;
              // Carry the buffers through: this read races the snapshot
              // restore, and dropping them here would silently undo it
              // whenever it lost.
              timeline = timelineFromMessages(cached.messages, timeline.streamingByAgent);
              const detailState = buildSessionDetailState(cached.session, cached.messages);
              setState({
                ...state,
                status: detailState.status,
                session: cached.session,
                messages: detailState.messages,
                errorMessage: null,
                streamingByAgent: timeline.streamingByAgent,
              });
            })
          : null;

      const [sessionResult, messagesResult] = await Promise.allSettled([
        deps.api.getSession(deps.teamId, deps.sessionId),
        deps.api.listMessagesPage(deps.teamId, deps.sessionId),
      ]);

      // Both disk reads raced the network, and the merge below has to see what
      // they left. The cache read decides what the fetched page is folded onto
      // — it covers the newest page only, while the `cache.save` after it
      // replaces the session's rows with whatever the timeline holds, so
      // landing it first is what keeps a transcript that was scrolled back on
      // disk instead of trimming it to one page. The snapshot read decides
      // which restored partials are still unfinished: the merge settles the
      // ones whose turn completed while the process was dead, and it can only
      // do that for buffers that have arrived.
      await Promise.all([hydrateFromCache, restoreSnapshot]);

      if (disposed || currentToken !== loadToken) {
        return;
      }

      if (sessionResult.status === "rejected") {
        // If cached rows already paint, keep them and surface the network
        // error inline rather than blanking the screen.
        if (state.session) {
          setState({
            ...state,
            status: "error",
            errorMessage: toErrorMessage(sessionResult.reason, "加载会话失败。"),
            isRefreshing: false,
          });
        } else {
          setState({
            ...state,
            status: "error",
            errorMessage: toErrorMessage(sessionResult.reason, "加载会话失败。"),
            isRefreshing: false,
          });
        }
        return;
      }

      const session = sessionResult.value;
      if (!session) {
        timeline = emptyTimelineState();
        setState({
          ...state,
          status: "not-found",
          session: null,
          messages: [],
          isRefreshing: false,
          streamingByAgent: timeline.streamingByAgent,
        });
        return;
      }

      if (messagesResult.status === "rejected") {
        setState({
          ...state,
          status: "error",
          session,
          messages: state.messages,
          errorMessage: toErrorMessage(messagesResult.reason, "加载消息失败。"),
          isRefreshing: false,
        });
        await connectRealtime(session, currentToken);
        return;
      }

      // The fetch above asks for the newest page only, so it cannot speak for
      // anything older — a page the user scrolled back to, or a longer
      // transcript hydrated from disk. Fold it in over that instead of
      // replacing it.
      timeline = mergeNewestPage(timeline, messagesResult.value.items);
      // A refresh reports the cursor sitting just behind the newest page. That
      // is only news if the user has not already walked past it.
      if (!hasWalkedBack) {
        olderCursor = messagesResult.value.nextCursor;
      }
      const detailState = buildSessionDetailState(session, timeline.messages);
      setState({
        ...state,
        status: detailState.status,
        session,
        messages: detailState.messages,
        errorMessage: null,
        isRefreshing: preserveExisting,
        streamingByAgent: timeline.streamingByAgent,
        canLoadOlder: olderCursor !== null,
      });

      // Persist authoritative network state for the next cold start.
      void deps.cache?.save(deps.sessionId, {
        session,
        messages: detailState.messages,
      });

      await connectRealtime(session, currentToken);
      if (!disposed && currentToken === loadToken && state.isRefreshing) {
        setState({
          ...state,
          isRefreshing: false,
        });
      }
    },
    async loadOlderMessages() {
      const cursor = olderCursor;
      if (!cursor || state.isLoadingOlder || !state.session) {
        return;
      }

      const currentToken = loadToken;
      setState({ ...state, isLoadingOlder: true });

      let page: { items: SessionMessage[]; nextCursor: string | null };
      try {
        page = await deps.api.listMessagesPage(deps.teamId, deps.sessionId, { cursor });
      } catch (error) {
        if (disposed || currentToken !== loadToken) return;
        // The transcript on screen is intact — only the page behind it is
        // missing — so this reports itself in the banner without disturbing the
        // timeline, and the cursor stays put so the header can retry the same
        // page. (`status` is what makes the banner render; the next timeline
        // change recomputes it back to ready.)
        setState({
          ...state,
          status: "error",
          isLoadingOlder: false,
          errorMessage: toErrorMessage(error, "加载更早的消息失败。"),
        });
        return;
      }

      // A reload landed while this page was in flight; it owns the timeline now.
      if (disposed || currentToken !== loadToken) return;

      hasWalkedBack = true;
      olderCursor = page.nextCursor;

      let next = timeline;
      for (const message of page.items) {
        next = reduceTimeline(next, { kind: "messageCommitted", message });
      }
      timeline = next;

      setState({
        ...state,
        messages: next.messages,
        errorMessage: null,
        canLoadOlder: olderCursor !== null,
        isLoadingOlder: false,
        status: nextStatusForMessages(state.session, next.messages, state.status),
      });
      // Older pages belong on disk too, so the next cold start opens where the
      // user left off instead of walking the same cursor again.
      scheduleTimelinePersist();
    },
    setComposerText(value) {
      setState({
        ...state,
        composerText: value,
        sendErrorMessage: null,
      });
    },
    async flushStreamingForBackground() {
      if (!deps.streamingSnapshots) return;
      // Land any pending timeline write too, so the cached timeline and the
      // snapshot describe the same moment.
      flushTimelinePersist();
      await deps.streamingSnapshots.save(deps.sessionId, timeline.streamingByAgent);
    },
    async discardBackgroundSnapshot() {
      await deps.streamingSnapshots?.clear(deps.sessionId);
    },
    resolvePendingQuestion(requestId) {
      const pendingQuestions = removePendingQuestion(state.pendingQuestions, requestId);
      if (pendingQuestions.length === state.pendingQuestions.length) return;
      setState({ ...state, pendingQuestions });
    },
    setReplyTarget(target) {
      setState({
        ...state,
        replyTarget: target,
      });
    },
    async sendMessage() {
      const content = state.composerText.trim();
      const session = state.session;

      if (!session) {
        return;
      }

      const hasPendingAttachments =
        peekPendingAttachments(deps.teamId, deps.sessionId).length > 0;
      if (!content && !hasPendingAttachments) {
        return;
      }

      if (state.connectionState !== "connected") {
        setState({
          ...state,
          sendErrorMessage:
            state.connectionState === "connecting"
              ? "实时连接准备中，请稍后再试。"
              : "实时连接暂时不可用，仍可稍后重试发送。",
        });
        return;
      }

      setState({
        ...state,
        isSending: true,
        sendErrorMessage: null,
      });

      let outboxMessageId: string | null = null;
      try {
        const auth = await deps.getAuth();
        if (!auth.accessToken) {
          throw new Error("实时连接暂时不可用，仍可稍后重试发送。");
        }

        const actorId = await resolveSenderActorId();
        const createdAt = new Date().toISOString();
        const createdAtSeconds = BigInt(Math.floor(Date.parse(createdAt) / 1000));
        const messageId = uuidV4();
        outboxMessageId = messageId;
        setOutboxStatus(messageId, "sending");

        const pendingAttachments = takePendingAttachments(deps.teamId, deps.sessionId);
        const attachmentsPayload = pendingAttachments.length > 0
          ? pendingAttachments.map((row) => ({
              url: row.publicUrl || row.path,
              path: row.path,
              mime: row.mime,
              size: row.size,
            }))
          : undefined;

        const replyTo = state.replyTarget?.messageId ?? null;
        const mentionActorIds = resolveMentionActorIdsForComposer({
          content,
          session,
          teamActors: deps.getTeamActors?.() ?? [],
        });

        await deps.api.insertOutgoingMessage({
          id: messageId,
          teamId: deps.teamId,
          sessionId: deps.sessionId,
          senderActorId: actorId,
          content,
          createdAt,
          metadata: { mention_actor_ids: mentionActorIds },
          attachments: attachmentsPayload,
          replyToMessageId: replyTo,
        });

        const optimisticMessage: SessionMessage = {
          content,
          createdAt,
          kind: "text",
          messageId,
          metadata: { mention_actor_ids: mentionActorIds },
          model: "",
          replyToMessageId: replyTo ?? "",
          senderActorId: actorId,
          sessionId: deps.sessionId,
          teamId: deps.teamId,
          turnId: "",
          attachments: attachmentsPayload,
        };

        const optimisticNext = reduceTimeline(timeline, { kind: "messageCommitted", message: optimisticMessage });
        timeline = optimisticNext;
        const mergedMessages = optimisticNext.messages;
        setState({
          ...state,
          composerText: "",
          messages: mergedMessages,
          streamingByAgent: optimisticNext.streamingByAgent,
          replyTarget: null,
          status: nextStatusForMessages(session, mergedMessages, state.status),
        });

        if (deps.outbox) {
          await deps.outbox.sender.enqueue({
            messageId,
            sessionId: deps.sessionId,
            teamId: deps.teamId,
            senderActorId: actorId,
            content,
            mentionActorIds,
            replyToMessageId: replyTo,
            attachments: pendingAttachments.map((row) => ({
              url: row.publicUrl || row.path,
              path: row.path,
              mime: row.mime,
              size: row.size,
            })),
            createdAt: Date.parse(createdAt),
          });
          await syncOutboxFromDao(deps.outbox.dao, [messageId]);
        } else {
          // Fallback path (existing inline publish)
          const protoMessage = create(MessageSchema, {
            messageId,
            sessionId: deps.sessionId,
            senderActorId: actorId,
            kind: MessageKind.TEXT,
            content,
            createdAt: createdAtSeconds,
          });
          const sessionMessage = create(SessionMessageEnvelopeSchema, {
            message: protoMessage,
            mentionActorIds,
          });
          const envelope = create(LiveEventEnvelopeSchema, {
            eventId: uuidV4(),
            eventType: "message.created",
            sessionId: deps.sessionId,
            actorId,
            sentAt: createdAtSeconds,
            body: toBinary(SessionMessageEnvelopeSchema, sessionMessage),
          });

          try {
            await deps.mqtt.publish(
              `amux/${deps.teamId}/session/${deps.sessionId}/live`,
              toBinary(LiveEventEnvelopeSchema, envelope),
              false,
            );
          } catch {
            setOutboxStatus(messageId, "failed");
            setState({
              ...state,
              messages: mergedMessages,
              streamingByAgent: optimisticNext.streamingByAgent,
              status: nextStatusForMessages(session, mergedMessages, state.status),
              composerText: "",
              isSending: false,
              sendErrorMessage: "消息已写入，但实时分发失败，请稍后刷新确认。",
            });
            return;
          }
        }

        setOutboxStatus(messageId, "sent");
        setState({
          ...state,
          messages: mergedMessages,
          streamingByAgent: optimisticNext.streamingByAgent,
          status: nextStatusForMessages(session, mergedMessages, state.status),
          composerText: "",
          isSending: false,
          sendErrorMessage: null,
        });
      } catch (error) {
        if (outboxMessageId) {
          setOutboxStatus(outboxMessageId, "failed");
        }
        setState({
          ...state,
          isSending: false,
          sendErrorMessage: toErrorMessage(error, "发送失败。"),
        });
      }
    },
    async dispose() {
      disposed = true;
      for (const entry of staleStreamTimers.values()) clearTimeout(entry.timer);
      staleStreamTimers.clear();
      // Last chance to keep whatever the coalescing window still holds.
      flushTimelinePersist();
      deps.outbox?.sender.stop();
      disconnectRealtime();
      setState({
        ...state,
        connectionState: "disconnected",
      });
    },
  };

  return controller;
}
