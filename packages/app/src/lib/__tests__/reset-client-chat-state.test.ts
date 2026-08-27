import { beforeEach, describe, expect, it } from "vitest";
import { create as createMessage } from "@bufbuild/protobuf";
import { MessageKind, MessageSchema } from "@/lib/proto/teamclu_pb";
import { resetClientChatState } from "@/lib/reset-client-chat-state";
import { useSessionSelectionStore } from "@/stores/session-selection-store";
import { useSessionMessageStore } from "@/stores/session-message-store";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { useStreamingStore } from "@/stores/streaming";
import { useEngagedAgentStore } from "@/stores/engaged-agent-store";
import { useSessionListStore } from "@/stores/session-list-store";
import { useSessionParticipantStore } from "@/stores/session-participant-store";
import { useSessionStore } from "@/stores/session-store";
import { useSessionNoticeStore } from "@/stores/session-notice-store";
import { useAgentModelPickStore } from "@/stores/agent-model-pick-store";

describe("resetClientChatState", () => {
  beforeEach(() => {
    useSessionSelectionStore.setState({
      activeSessionId: "session-a",
      currentSessionId: "session-a",
    viewingArchivedSessionId: null,
  });
    useSessionMessageStore.setState({
      messages: {
        "session-a": [
          createMessage(MessageSchema, {
            messageId: "m1",
            sessionId: "session-a",
            senderActorId: "actor-1",
            kind: MessageKind.TEXT,
            content: "hello",
            createdAt: 1n,
          }),
        ],
      },
      messageRefreshTrigger: 2,
      messageRefreshForceFull: true,
    });
    useV2StreamingStore.getState().appendOutput("session-a", "actor-1", "streaming");
    useStreamingStore.setState({
      streamingMessageId: "stream-1",
      streamingContent: "partial",
      childSessionStreaming: { "child-1": { isStreaming: true, text: "x" } },
    });
    useEngagedAgentStore.getState().setAgents("session-a", [
      { id: "agent-1", displayName: "Agent" },
    ]);
    useSessionListStore.setState({
      rows: [{ id: "session-a", title: "Old", created_at: "", last_message_at: null, last_message_preview: null, has_unread: false }],
      loading: false,
      highlightedSessionIds: ["session-a"],
    });
    useSessionParticipantStore.setState({
      participantsBySession: {
        "session-a": [{ actorId: "actor-1", displayName: "A", avatarUrl: null, isAgent: false }],
      },
    });
    useSessionStore.setState({
      draftInput: "draft",
      pendingPermissions: [{ id: "perm-1" }],
    });
    useSessionNoticeStore.setState({
      bySession: { "session-a": [{ id: "n1", message: "notice" }] },
    });
    useAgentModelPickStore.setState({
      bySessionAgent: { "session-a": { "agent-1": "model-a" } },
    });
  });

  it("clears selection, persisted messages, and live streams", () => {
    resetClientChatState();

    expect(useSessionSelectionStore.getState().activeSessionId).toBeNull();
    expect(useSessionMessageStore.getState().messages).toEqual({});
    expect(useSessionMessageStore.getState().messageRefreshTrigger).toBe(0);
    expect(useSessionListStore.getState().rows).toEqual([]);
    expect(useSessionListStore.getState().loading).toBe(true);
    expect(useSessionListStore.getState().highlightedSessionIds).toEqual([]);
    expect(useSessionParticipantStore.getState().participantsBySession).toEqual({});
    expect(useSessionStore.getState().draftInput).toBe("");
    expect(useSessionStore.getState().pendingPermissions).toEqual([]);
    expect(Object.keys(useV2StreamingStore.getState().byKey)).toHaveLength(0);
    expect(useV2StreamingStore.getState().archived).toHaveLength(0);
    expect(useStreamingStore.getState().streamingMessageId).toBeNull();
    expect(useStreamingStore.getState().childSessionStreaming).toEqual({});
    expect(useEngagedAgentStore.getState().getAgents("session-a")).toEqual([]);
    expect(useSessionNoticeStore.getState().bySession).toEqual({});
    expect(useAgentModelPickStore.getState().bySessionAgent).toEqual({});
  });
});
