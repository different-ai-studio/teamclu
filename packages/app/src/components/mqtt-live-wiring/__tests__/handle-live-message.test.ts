import { beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { handleLiveMessage } from "../handle-live-message";
import type { LiveWiringContext } from "../context";
import {
  LiveEventEnvelopeSchema,
  MessageKind,
  MessageSchema,
} from "@/lib/proto/teamclu_pb";
import {
  flushPendingSessionRevisionsForTests,
  useV2StreamingStore,
} from "@/stores/v2-streaming-store";
import { useSessionMessageStore } from "@/stores/session-message-store";

vi.mock("@/lib/cache/local-cache", () => ({
  upsertMessagesBatch: vi.fn().mockResolvedValue(undefined),
}));

const SESSION_ID = "sess-wecom";
const ACTOR_ID = "actor-1";
const STREAM_KEY = `${SESSION_ID}::${ACTOR_ID}`;

function resetStores() {
  flushPendingSessionRevisionsForTests();
  useV2StreamingStore.setState({
    byKey: {},
    archived: [],
    persistedPlansBySession: {},
    interruptedFlushPending: {},
    revisionBySession: {},
  });
  useSessionMessageStore.setState({ messages: {} });
}

function mockCtx(overrides: Partial<LiveWiringContext> = {}): LiveWiringContext {
  const flushTurnAgentReply = vi.fn().mockReturnValue(true);
  return {
    pendingStreamRepliesRef: { current: {} },
    terminalFlushPendingRef: { current: {} },
    followUpActiveRef: { current: {} },
    clearTerminalFlushPending: vi.fn(),
    clearFollowUpActive: vi.fn(),
    flushTurnAgentReply,
    scheduleTerminalDaemonReplyTimeout: vi.fn(),
    removeInterruptedStreamPlaceholderForRealReply: vi.fn(),
    ...overrides,
  };
}

function agentReplyEvent(content: string) {
  const message = create(MessageSchema, {
    messageId: "reply-1",
    sessionId: SESSION_ID,
    senderActorId: ACTOR_ID,
    kind: MessageKind.AGENT_REPLY,
    content,
    turnId: "turn-1",
  });
  return {
    envelope: create(LiveEventEnvelopeSchema, {
      eventId: "evt-1",
      eventType: "message.created",
      sessionId: SESSION_ID,
      actorId: ACTOR_ID,
    }),
    message,
  };
}

describe("handleLiveMessage parked AGENT_REPLY", () => {
  beforeEach(() => {
    resetStores();
  });

  it("parks a mid-turn AGENT_REPLY while the live stream is still active", () => {
    const store = useV2StreamingStore.getState();
    store.appendThinking(SESSION_ID, ACTOR_ID, "先想一下");
    store.appendOutput(SESSION_ID, ACTOR_ID, "还没说完");

    const ctx = mockCtx();
    handleLiveMessage(ctx, agentReplyEvent("还没说完"), SESSION_ID);

    expect(ctx.flushTurnAgentReply).not.toHaveBeenCalled();
    expect(ctx.pendingStreamRepliesRef.current[STREAM_KEY]).toHaveLength(1);
    expect(useSessionMessageStore.getState().messages[SESSION_ID]).toBeUndefined();
  });

  it("flushes write_reply after Idle timeout closed the dock (stream inactive, terminalPending cleared)", () => {
    const store = useV2StreamingStore.getState();
    store.appendThinking(SESSION_ID, ACTOR_ID, "先刷新再回答");
    store.appendOutput(SESSION_ID, ACTOR_ID, "今天的情况是…");
    store.finishSessionActor(SESSION_ID, ACTOR_ID, {
      reason: "statusChange.terminal.timeout",
    });
    expect(useV2StreamingStore.getState().byKey[STREAM_KEY]?.active).toBe(false);

    const ctx = mockCtx();
    handleLiveMessage(ctx, agentReplyEvent("今天的情况是…"), SESSION_ID);

    expect(ctx.flushTurnAgentReply).toHaveBeenCalledWith(
      SESSION_ID,
      ACTOR_ID,
      "mqtt.message.created.streamInactive",
    );
    expect(ctx.pendingStreamRepliesRef.current[STREAM_KEY]).toHaveLength(1);
  });

  it("still flushes when terminal Idle is waiting for daemon write_reply", () => {
    const store = useV2StreamingStore.getState();
    store.appendThinking(SESSION_ID, ACTOR_ID, "思考");
    store.appendOutput(SESSION_ID, ACTOR_ID, "答案");

    const ctx = mockCtx({
      terminalFlushPendingRef: { current: { [STREAM_KEY]: true } },
    });
    handleLiveMessage(ctx, agentReplyEvent("答案"), SESSION_ID);

    expect(ctx.flushTurnAgentReply).toHaveBeenCalledWith(
      SESSION_ID,
      ACTOR_ID,
      "mqtt.message.created.terminalPending",
    );
  });
});
