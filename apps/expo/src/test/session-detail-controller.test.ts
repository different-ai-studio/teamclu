import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AcpEventSchema,
  EnvelopeSchema as AmuxEnvelopeSchema,
} from "@teamclu/app/proto/amux_pb";
import {
  LiveEventEnvelopeSchema,
  MessageKind,
  MessageSchema,
  SessionMessageEnvelopeSchema,
} from "@teamclu/app/proto/teamclu_pb";
import type { SessionMessage, SessionSummary } from "../features/sessions/session-types";

function createSession(): SessionSummary {
  return {
    sessionId: "session-1",
    teamId: "team-1",
    title: "Session title",
    summary: "",
    participantCount: 2,
    participantActorIds: ["actor-1", "actor-agent"],
    lastMessagePreview: "Latest preview",
    lastMessageAt: "2026-05-19T08:20:00.000Z",
    createdAt: "2026-05-19T08:00:00.000Z",
    createdBy: "actor-1",
  };
}

function createRowMessage(
  messageId: string,
  senderActorId = "actor-1",
  createdAt = "2026-05-19T08:20:00.000Z",
): SessionMessage {
  return {
    content: `Message ${messageId}`,
    createdAt,
    kind: "text",
    messageId,
    metadata: null,
    model: "",
    replyToMessageId: "",
    senderActorId,
    sessionId: "session-1",
    teamId: "team-1",
    turnId: "",
  };
}

type MessagePage = { items: SessionMessage[]; nextCursor: string | null };

/** What `listMessagesPage` answers with: one page, plus the cursor behind it. */
function page(items: SessionMessage[], nextCursor: string | null = null): MessagePage {
  return { items, nextCursor };
}

function createLivePayload(input: {
  content: string;
  createdAtSeconds?: bigint;
  messageId: string;
  senderActorId: string;
}) {
  const message = create(MessageSchema, {
    messageId: input.messageId,
    sessionId: "session-1",
    senderActorId: input.senderActorId,
    kind: MessageKind.TEXT,
    content: input.content,
    createdAt: input.createdAtSeconds ?? BigInt(1_747_642_000),
  });
  const sessionMessage = create(SessionMessageEnvelopeSchema, {
    message,
    mentionActorIds: [],
  });
  const envelope = create(LiveEventEnvelopeSchema, {
    eventId: `event-${input.messageId}`,
    eventType: "message.created",
    sessionId: "session-1",
    actorId: input.senderActorId,
    sentAt: input.createdAtSeconds ?? BigInt(1_747_642_000),
    body: toBinary(SessionMessageEnvelopeSchema, sessionMessage),
  });

  return toBinary(LiveEventEnvelopeSchema, envelope);
}

function createAcpOutputPayload(input: {
  actorId: string;
  eventId: string;
  isComplete?: boolean;
  model?: string;
  sequence?: bigint;
  text: string;
}) {
  const acpEvent = create(AcpEventSchema, {
    event: {
      case: "output",
      value: {
        text: input.text,
        isComplete: input.isComplete ?? false,
      },
    },
    model: input.model ?? "",
  });
  const amuxEnvelope = create(AmuxEnvelopeSchema, {
    runtimeId: "runtime-1",
    actorId: "actor-1",
    sequence: input.sequence ?? BigInt(1),
    timestamp: BigInt(1_747_642_000),
    payload: {
      case: "acpEvent",
      value: acpEvent,
    },
  });
  const liveEvent = create(LiveEventEnvelopeSchema, {
    eventId: input.eventId,
    eventType: "acp.event",
    sessionId: "session-1",
    actorId: input.actorId,
    sentAt: BigInt(1_747_642_000),
    body: toBinary(AmuxEnvelopeSchema, amuxEnvelope),
  });

  return toBinary(LiveEventEnvelopeSchema, liveEvent);
}

function createAcpThinkingPayload(input: {
  actorId: string;
  eventId: string;
  model?: string;
  sequence?: bigint;
  text: string;
}) {
  const acpEvent = create(AcpEventSchema, {
    event: {
      case: "thinking",
      value: {
        text: input.text,
      },
    },
    model: input.model ?? "",
  });
  const amuxEnvelope = create(AmuxEnvelopeSchema, {
    runtimeId: "runtime-1",
    actorId: "actor-1",
    sequence: input.sequence ?? BigInt(1),
    timestamp: BigInt(1_747_642_000),
    payload: {
      case: "acpEvent",
      value: acpEvent,
    },
  });
  const liveEvent = create(LiveEventEnvelopeSchema, {
    eventId: input.eventId,
    eventType: "acp.event",
    sessionId: "session-1",
    actorId: input.actorId,
    sentAt: BigInt(1_747_642_000),
    body: toBinary(AmuxEnvelopeSchema, amuxEnvelope),
  });

  return toBinary(LiveEventEnvelopeSchema, liveEvent);
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

function createMockMqtt() {
  // Maps filter → handler. Uses the first registered handler per filter
  // for simplicity (the controller only subscribes once per topic).
  const topicHandlers = new Map<string, (payload: Uint8Array, topic: string) => void>();
  const connectionStateListeners = new Set<
    (state: "connecting" | "connected" | "disconnected") => void
  >();

  return {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn((filter: string, handler: (payload: Uint8Array, topic: string) => void) => {
      topicHandlers.set(filter, handler);
      return () => {
        topicHandlers.delete(filter);
      };
    }),
    onConnectionState: vi.fn(
      (handler: (state: "connecting" | "connected" | "disconnected") => void) => {
        connectionStateListeners.add(handler);
        return () => {
          connectionStateListeners.delete(handler);
        };
      },
    ),
    /** Simulate an inbound MQTT message on a given topic. */
    emit(topic: string, payload: Uint8Array) {
      for (const [filter, handler] of topicHandlers) {
        // Simple exact-match check is sufficient for these tests.
        if (filter === topic) {
          handler(payload, topic);
        }
      }
    },
    emitConnectionState(state: "connecting" | "connected" | "disconnected") {
      for (const listener of connectionStateListeners) {
        listener(state);
      }
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createSessionDetailController", () => {
  it("loads into ready state and connects realtime for the active session", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessagesPage: vi.fn().mockResolvedValue(page([createRowMessage("message-1")])),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();

    expect(controller.getState()).toMatchObject({
      connectionState: "connected",
      messages: [expect.objectContaining({ messageId: "message-1" })],
      status: "ready",
    });
    expect(mqtt.subscribe).toHaveBeenCalledWith(
      "amux/team-1/session/session-1/live",
      expect.any(Function),
    );
  });

  it("optimistically appends a sent message and clears the composer text", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn().mockResolvedValue(undefined),
      listMessagesPage: vi.fn().mockResolvedValue(page([])),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();
    controller.setComposerText("hello");
    await controller.sendMessage();

    expect(controller.getState().composerText).toBe("");
    expect(controller.getState().messages).toHaveLength(1);
    expect(controller.getState().messages[0]?.content).toBe("hello");
    expect(mqtt.publish).toHaveBeenCalledTimes(1);
  });

  it("mentions the sole agent participant when sending from the composer", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn().mockResolvedValue(undefined),
      listMessagesPage: vi.fn().mockResolvedValue(page([])),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      getTeamActors: () => [
        {
          actorId: "actor-1",
          actorType: "member",
          avatarUrl: null,
          displayName: "Me",
          agentTypes: [],
          defaultAgentType: null,
          agentKind: null,
          lastActiveAt: null,
          role: null,
          teamId: "team-1",
        },
        {
          actorId: "actor-agent",
          actorType: "agent",
          avatarUrl: null,
          displayName: "Codex",
          agentTypes: ["codex"],
          defaultAgentType: "codex",
          agentKind: "codex",
          lastActiveAt: null,
          role: null,
          teamId: "team-1",
        },
      ],
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    } as any);

    await controller.load();
    controller.setComposerText("hello daemon");
    await controller.sendMessage();

    expect(api.insertOutgoingMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { mention_actor_ids: ["actor-agent"] },
      }),
    );
    expect(controller.getState().messages[0]).toMatchObject({
      metadata: { mention_actor_ids: ["actor-agent"] },
    });

    const publishBytes = mqtt.publish.mock.calls[0]?.[1] as Uint8Array;
    const live = fromBinary(LiveEventEnvelopeSchema, publishBytes);
    const sessionMessage = fromBinary(SessionMessageEnvelopeSchema, live.body);
    expect(sessionMessage.mentionActorIds).toEqual(["actor-agent"]);
  });

  it("sends a pending attachment even when composer text is empty", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const { appendPendingAttachment, takePendingAttachments } = await import(
      "../features/sessions/pending-attachments"
    );
    takePendingAttachments("team-1", "session-1");
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn().mockResolvedValue(undefined),
      listMessagesPage: vi.fn().mockResolvedValue(page([])),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    appendPendingAttachment("team-1", "session-1", {
      path: "team-1/session-1/photo.png",
      publicUrl: "https://storage.example.test/photo.png?token=abc",
      mime: "image/png",
      size: 123,
    });
    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();
    await controller.sendMessage();

    expect(api.insertOutgoingMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "",
        attachments: [
          {
            url: "https://storage.example.test/photo.png?token=abc",
            path: "team-1/session-1/photo.png",
            mime: "image/png",
            size: 123,
          },
        ],
      }),
    );
    expect(controller.getState().messages[0]).toMatchObject({
      content: "",
      attachments: [
        {
          url: "https://storage.example.test/photo.png?token=abc",
          path: "team-1/session-1/photo.png",
        },
      ],
    });
    expect(takePendingAttachments("team-1", "session-1")).toHaveLength(0);
  });

  it("blocks sends until realtime has finished connecting", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    // Defer the second listMessagesPage call (the one inside connectRealtime)
    // so the controller stays in "connecting" long enough to test the guard.
    const deferredMessagePage = createDeferred<MessagePage>();
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn().mockResolvedValue(undefined),
      listMessagesPage: vi.fn()
        .mockResolvedValueOnce(page([])) // first call (load phase)
        .mockReturnValueOnce(deferredMessagePage.promise), // second call (connectRealtime)
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    const loadPromise = controller.load();
    // Wait for the load to publish the session — the point the send guard
    // needs — rather than counting microtasks, which changes whenever the load
    // path gains an await. connectRealtime is still blocked on the deferred
    // page, so there is no overshooting it.
    for (let i = 0; i < 50 && controller.getState().session === null; i += 1) {
      await Promise.resolve();
    }
    controller.setComposerText("too early");
    await controller.sendMessage();

    // connectionState should not yet be "connected" so send is blocked.
    expect(controller.getState().sendErrorMessage).toMatch(/^实时连接/);
    expect(api.insertOutgoingMessage).not.toHaveBeenCalled();

    deferredMessagePage.resolve(page([]));
    await loadPromise;
  });

  it("ignores duplicate mqtt messages by messageId", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessagesPage: vi.fn().mockResolvedValue(page([createRowMessage("message-1")])),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();
    mqtt.emit(
      "amux/team-1/session/session-1/live",
      createLivePayload({
        content: "duplicate",
        messageId: "message-1",
        senderActorId: "actor-agent",
      }),
    );

    expect(controller.getState().messages).toHaveLength(1);
  });

  it("merges a subsequent agent reply from mqtt", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessagesPage: vi.fn().mockResolvedValue(page([])),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();
    mqtt.emit(
      "amux/team-1/session/session-1/live",
      createLivePayload({
        content: "agent reply",
        messageId: "agent-reply-1",
        senderActorId: "actor-agent",
      }),
    );

    expect(controller.getState().messages).toEqual([
      expect.objectContaining({
        content: "agent reply",
        messageId: "agent-reply-1",
        senderActorId: "actor-agent",
      }),
    ]);
  });

  it("streams acp output events into the agent buffer", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessagesPage: vi.fn().mockResolvedValue(page([])),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();
    mqtt.emit(
      "amux/team-1/session/session-1/live",
      createAcpOutputPayload({
        actorId: "actor-agent",
        eventId: "event-output-1",
        text: "Hel",
        sequence: BigInt(11),
      }),
    );
    mqtt.emit(
      "amux/team-1/session/session-1/live",
      createAcpOutputPayload({
        actorId: "actor-agent",
        eventId: "event-output-2",
        text: "lo",
        sequence: BigInt(12),
        isComplete: true,
        model: "gpt-5.2",
      }),
    );

    const stream = controller.getState().streamingByAgent.get("actor-agent");
    expect(stream).toMatchObject({
      isComplete: true,
      kind: "agent_reply",
      model: "gpt-5.2",
      senderActorId: "actor-agent",
      text: "Hello",
    });
    expect(controller.getState().messages).toEqual([]);
  });

  it("closes a stream that goes silent — iOS's stale-run watchdog", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessagesPage: vi.fn().mockResolvedValue(page([])),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };
    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({ accessToken: "jwt-token", userId: "user-1" }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
      staleStreamTimeoutMs: 40,
    });
    await controller.load();

    const emit = (text: string, seq: number) =>
      mqtt.emit(
        "amux/team-1/session/session-1/live",
        createAcpOutputPayload({ actorId: "actor-agent", eventId: `e-${seq}`, text, sequence: BigInt(seq) }),
      );
    emit("Hel", 11);
    await new Promise((r) => setTimeout(r, 25));
    emit("lo", 12); // a delta re-arms the timer
    await new Promise((r) => setTimeout(r, 25));
    expect(controller.getState().streamingByAgent.get("actor-agent")?.isComplete).toBeFalsy();

    await new Promise((r) => setTimeout(r, 40)); // now silent past the window
    expect(controller.getState().streamingByAgent.get("actor-agent")).toMatchObject({
      isComplete: true,
      text: "Hello",
    });
    await controller.dispose();
  });

  it("preserves raw acp thinking chunks including leading spaces and punctuation", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessagesPage: vi.fn().mockResolvedValue(page([])),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();
    mqtt.emit(
      "amux/team-1/session/session-1/live",
      createAcpThinkingPayload({
        actorId: "actor-agent",
        eventId: "event-thinking-1",
        text: "I need",
        sequence: BigInt(21),
      }),
    );
    mqtt.emit(
      "amux/team-1/session/session-1/live",
      createAcpThinkingPayload({
        actorId: "actor-agent",
        eventId: "event-thinking-2",
        text: " to inspect",
        sequence: BigInt(22),
      }),
    );
    mqtt.emit(
      "amux/team-1/session/session-1/live",
      createAcpThinkingPayload({
        actorId: "actor-agent",
        eventId: "event-thinking-3",
        text: ".",
        sequence: BigInt(23),
      }),
    );

    expect(controller.getState().messages.map((message) => message.content)).toEqual([
      "I need",
      " to inspect",
      ".",
    ]);
  });

  it("replays persisted messages fetched after subscribe to close the load gap", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessagesPage: vi
        .fn()
        .mockResolvedValueOnce(page([]))
        .mockResolvedValueOnce(page([createRowMessage("message-gap", "actor-agent")])),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();

    expect(api.listMessagesPage).toHaveBeenCalledTimes(2);
    expect(controller.getState().messages).toEqual([
      expect.objectContaining({ messageId: "message-gap" }),
    ]);
  });

  it("keeps the current session visible while a pull refresh is in flight", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const deferredRefreshMessages = createDeferred<MessagePage>();
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessagesPage: vi
        .fn()
        .mockResolvedValueOnce(page([createRowMessage("message-1")]))
        .mockResolvedValueOnce(page([createRowMessage("message-1")]))
        .mockReturnValueOnce(deferredRefreshMessages.promise)
        .mockResolvedValueOnce(page([createRowMessage("message-2", "actor-agent")])),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();
    const refreshPromise = controller.load({ preserveExisting: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.getState()).toMatchObject({
      isRefreshing: true,
      messages: [expect.objectContaining({ messageId: "message-1" })],
      session: expect.objectContaining({ sessionId: "session-1" }),
      status: "ready",
    });

    deferredRefreshMessages.resolve(page([createRowMessage("message-2", "actor-agent")]));
    await refreshPromise;

    expect(controller.getState()).toMatchObject({
      isRefreshing: false,
      messages: [expect.objectContaining({ messageId: "message-2" })],
      status: "ready",
    });
  });

  it("preserves composer text when send insert fails", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn().mockRejectedValue(new Error("insert failed")),
      listMessagesPage: vi.fn().mockResolvedValue(page([])),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();
    controller.setComposerText("still here");
    await controller.sendMessage();

    expect(controller.getState()).toMatchObject({
      composerText: "still here",
      sendErrorMessage: "insert failed",
    });
  });

  it("does not let stale connect completions mutate a disposed controller", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    // Defer the second listMessagesPage call inside connectRealtime so we can
    // dispose the controller while it is still mid-flight.
    const deferredMessagePage = createDeferred<MessagePage>();
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessagesPage: vi.fn()
        .mockResolvedValueOnce(page([])) // first call (load phase)
        .mockReturnValueOnce(deferredMessagePage.promise), // second call (connectRealtime)
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    const loadPromise = controller.load();
    controller.dispose();
    deferredMessagePage.resolve(page([]));
    await loadPromise;

    expect(controller.getState().connectionState).toBe("disconnected");
  });

  it("downgrades the connection state when realtime drops after load", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessagesPage: vi.fn().mockResolvedValue(page([])),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();
    mqtt.emitConnectionState("disconnected");

    expect(controller.getState().connectionState).toBe("disconnected");
  });
});

describe("timeline persistence", () => {
  function createMockCache() {
    return {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      saveMessages: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };
  }

  async function loadWithCache(cache: ReturnType<typeof createMockCache>) {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessagesPage: vi.fn().mockResolvedValue(page([])),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };
    const controller = createSessionDetailController({
      api: api as any,
      cache: cache as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({ accessToken: "jwt", userId: "user-1" }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });
    await controller.load();
    return { controller, mqtt, cache };
  }

  it("persists an agent's ACP trace, which used to die with the process", async () => {
    const cache = createMockCache();
    const { controller, mqtt } = await loadWithCache(cache);
    cache.saveMessages.mockClear();

    mqtt.emit(
      "amux/team-1/session/session-1/live",
      createAcpThinkingPayload({
        actorId: "actor-agent",
        eventId: "event-thinking-1",
        text: "Checking the repo",
        sequence: BigInt(41),
      }),
    );

    // Writes coalesce, so nothing has hit the cache yet…
    expect(cache.saveMessages).not.toHaveBeenCalled();

    // …until the window closes, or the controller tears down.
    await controller.dispose();

    expect(cache.saveMessages).toHaveBeenCalledTimes(1);
    const [sessionId, messages] = cache.saveMessages.mock.calls[0];
    expect(sessionId).toBe("session-1");
    expect(messages).toEqual([
      expect.objectContaining({ kind: "agent_thinking", content: "Checking the repo" }),
    ]);
  });

  it("coalesces a burst into one write rather than one per event", async () => {
    vi.useFakeTimers();
    const cache = createMockCache();
    const { mqtt } = await loadWithCache(cache);
    cache.saveMessages.mockClear();

    for (let i = 0; i < 5; i += 1) {
      mqtt.emit(
        "amux/team-1/session/session-1/live",
        createAcpThinkingPayload({
          actorId: "actor-agent",
          eventId: `event-burst-${i}`,
          text: `chunk ${i}`,
          sequence: BigInt(50 + i),
        }),
      );
    }

    expect(cache.saveMessages).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(cache.saveMessages).toHaveBeenCalledTimes(1);

    // The single write carries every event from the burst.
    const [, messages] = cache.saveMessages.mock.calls[0];
    expect(messages).toHaveLength(5);
  });
});


describe("reconnect recovery", () => {
  async function setup() {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessagesPage: vi.fn().mockResolvedValue(page([createRowMessage("message-1")])),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };
    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({ accessToken: "jwt", userId: "user-1" }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });
    await controller.load();
    return { api, controller, mqtt };
  }

  it("refetches after the socket drops and comes back", async () => {
    // The session's `live` topic is not retained, so anything published during
    // the gap is never redelivered on resubscribe — without this the timeline
    // silently stays short until the screen is reopened.
    const { api, controller, mqtt } = await setup();
    const callsAfterLoad = api.listMessagesPage.mock.calls.length;

    mqtt.emitConnectionState("connected");
    mqtt.emitConnectionState("disconnected");
    mqtt.emitConnectionState("connected");
    await Promise.resolve();
    await Promise.resolve();

    expect(api.listMessagesPage.mock.calls.length).toBeGreaterThan(callsAfterLoad);
    await controller.dispose();
  });

  it("does not refetch on the first connect — that load is already in flight", async () => {
    const { api, controller, mqtt } = await setup();
    const callsAfterLoad = api.listMessagesPage.mock.calls.length;

    mqtt.emitConnectionState("connecting");
    mqtt.emitConnectionState("connected");
    await Promise.resolve();
    await Promise.resolve();

    expect(api.listMessagesPage).toHaveBeenCalledTimes(callsAfterLoad);
    await controller.dispose();
  });

  it("keeps the timeline on screen while the catch-up runs", async () => {
    const { controller, mqtt } = await setup();
    expect(controller.getState().messages.length).toBeGreaterThan(0);

    mqtt.emitConnectionState("connected");
    mqtt.emitConnectionState("disconnected");
    mqtt.emitConnectionState("connected");

    // preserveExisting: a reconnect must not blank the screen the way a cold
    // load does.
    expect(controller.getState().messages.length).toBeGreaterThan(0);
    await controller.dispose();
  });
});

describe("createSessionDetailController · back-scroll", () => {
  const newest = createRowMessage("message-newest", "actor-1", "2026-05-19T08:20:00.000Z");
  const older = createRowMessage("message-older", "actor-1", "2026-05-19T07:00:00.000Z");

  /**
   * Stands in for `/v1/sessions/:id/messages`: no cursor is the newest page,
   * and the cursor it reports reaches the page before it.
   */
  function createPagedApi(newestCursor: string | null = "cursor-1") {
    return {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessagesPage: vi.fn(
        async (_teamId: string, _sessionId: string, opts?: { cursor?: string | null }) =>
          opts?.cursor ? page([older], null) : page([newest], newestCursor),
      ),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };
  }

  async function setup(api: ReturnType<typeof createPagedApi>) {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({ accessToken: "jwt-token", userId: "user-1" }),
      mqtt: createMockMqtt() as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });
    await controller.load();
    return controller;
  }

  it("walks the cursor back and puts the older page above the newest one", async () => {
    const controller = await setup(createPagedApi());
    expect(controller.getState().canLoadOlder).toBe(true);

    await controller.loadOlderMessages();

    expect(controller.getState().messages.map((m) => m.messageId)).toEqual([
      "message-older",
      "message-newest",
    ]);
    expect(controller.getState().isLoadingOlder).toBe(false);
    // The older page came back without a cursor: that is the start of the session.
    expect(controller.getState().canLoadOlder).toBe(false);
    await controller.dispose();
  });

  it("stays put when the newest page is the whole session", async () => {
    const api = createPagedApi(null);
    const controller = await setup(api);
    expect(controller.getState().canLoadOlder).toBe(false);

    const callsAfterLoad = api.listMessagesPage.mock.calls.length;
    await controller.loadOlderMessages();

    expect(api.listMessagesPage).toHaveBeenCalledTimes(callsAfterLoad);
    await controller.dispose();
  });

  it("keeps back-scrolled history through a refresh", async () => {
    const controller = await setup(createPagedApi());
    await controller.loadOlderMessages();

    // A refresh only asks for the newest page. It used to replace the timeline
    // with it, which threw away everything the user had scrolled back to.
    await controller.load({ preserveExisting: true });

    expect(controller.getState().messages.map((m) => m.messageId)).toEqual([
      "message-older",
      "message-newest",
    ]);
    // And it must not rewind the cursor to the page already read past.
    expect(controller.getState().canLoadOlder).toBe(false);
    await controller.dispose();
  });

  it("leaves the transcript alone when an older page fails to load", async () => {
    const api = createPagedApi();
    api.listMessagesPage = vi.fn(
      async (_teamId: string, _sessionId: string, opts?: { cursor?: string | null }) => {
        if (opts?.cursor) throw new Error("network down");
        return page([newest], "cursor-1");
      },
    );
    const controller = await setup(api);

    await controller.loadOlderMessages();

    expect(controller.getState().messages.map((m) => m.messageId)).toEqual(["message-newest"]);
    expect(controller.getState().isLoadingOlder).toBe(false);
    expect(controller.getState().errorMessage).toBe("network down");
    // "error" is what renders the banner; without it the failure is silent.
    expect(controller.getState().status).toBe("error");
    // The cursor survives the failure, so the next pull retries the same page.
    expect(controller.getState().canLoadOlder).toBe(true);
    await controller.dispose();
  });
});

describe("createSessionDetailController · cold start over a cached transcript", () => {
  it("keeps cached history that predates the page the server returns", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const older = createRowMessage("message-older", "actor-1", "2026-05-19T07:00:00.000Z");
    const newest = createRowMessage("message-newest", "actor-1", "2026-05-19T08:20:00.000Z");
    const cache = {
      // What a previous back-scroll left behind.
      load: vi.fn().mockResolvedValue({ session: createSession(), messages: [older, newest] }),
      save: vi.fn().mockResolvedValue(undefined),
      saveMessages: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessagesPage: vi.fn().mockResolvedValue(page([newest], "cursor-1")),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };
    const controller = createSessionDetailController({
      api: api as any,
      cache: cache as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({ accessToken: "jwt", userId: "user-1" }),
      mqtt: createMockMqtt() as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();

    expect(controller.getState().messages.map((m) => m.messageId)).toEqual([
      "message-older",
      "message-newest",
    ]);
    // And the write-back must not trim the session's rows to the one page the
    // network answered with.
    expect(cache.save).toHaveBeenCalledWith("session-1", {
      session: expect.objectContaining({ sessionId: "session-1" }),
      messages: [
        expect.objectContaining({ messageId: "message-older" }),
        expect.objectContaining({ messageId: "message-newest" }),
      ],
    });
    await controller.dispose();
  });
});

describe("createSessionDetailController · restored streaming snapshot", () => {
  function createSnapshotStore(buffers: Array<[string, any]>) {
    return {
      load: vi.fn().mockResolvedValue(new Map(buffers)),
      save: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };
  }

  const partial = {
    isComplete: false,
    messageId: "acp:session-1:actor-agent:event-1",
    model: "",
    text: "Half a thou",
    kind: "agent_reply",
    startedAt: "2026-05-19T08:19:00.000Z",
    senderActorId: "actor-agent",
  };

  async function loadWith(
    streamingSnapshots: ReturnType<typeof createSnapshotStore>,
    items: SessionMessage[],
  ) {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const controller = createSessionDetailController({
      api: {
        getSession: vi.fn().mockResolvedValue(createSession()),
        insertOutgoingMessage: vi.fn(),
        listMessagesPage: vi.fn().mockResolvedValue(page(items)),
        resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
        markSessionRead: vi.fn().mockResolvedValue(undefined),
      } as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({ accessToken: "jwt", userId: "user-1" }),
      mqtt: createMockMqtt() as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      streamingSnapshots: streamingSnapshots as any,
      teamId: "team-1",
    });
    await controller.load();
    return controller;
  }

  it("survives the load that used to wipe it", async () => {
    // The turn never finished, so the page carries nothing from that agent —
    // the partial is all the user has of it.
    const controller = await loadWith(createSnapshotStore([["actor-agent", partial]]), [
      createRowMessage("message-1"),
    ]);

    expect(controller.getState().streamingByAgent.get("actor-agent")?.text).toBe("Half a thou");
    await controller.dispose();
  });

  it("gives way to the finished message when the turn completed while away", async () => {
    const finished: SessionMessage = {
      ...createRowMessage("message-agent-reply", "actor-agent"),
      kind: "agent_reply",
      content: "Half a thought, finished",
    };
    const controller = await loadWith(createSnapshotStore([["actor-agent", partial]]), [finished]);

    expect(controller.getState().streamingByAgent.has("actor-agent")).toBe(false);
    expect(controller.getState().messages.map((m) => m.messageId)).toEqual([
      "message-agent-reply",
    ]);
    await controller.dispose();
  });
});
