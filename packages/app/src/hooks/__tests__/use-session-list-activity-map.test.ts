import { beforeEach, describe, expect, it } from "vitest";
import { buildSessionListActivityMap } from "@/lib/session/session-list-activity";
import { useSessionStore } from "@/stores/session-store";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { useSessionListActivityMap } from "@/hooks/use-session-list-activity-map";
import { renderHook } from "@testing-library/react";

describe("useSessionListActivityMap", () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessions: [{ id: "sess-a", title: "A", messages: [], updatedAt: new Date(), createdAt: new Date() }],
      activeSessionId: "sess-a",
      pendingPermissions: [],
      pendingQuestions: [],
      pendingQuestionIdsBySession: {},
      sessionStatuses: {},
    });
    useV2StreamingStore.setState({
      byKey: {
        "sess-a::agent-1": {
          sessionId: "sess-a",
          actorId: "agent-1",
          outputText: "",
          thinkingText: "",
          parts: [],
          toolCalls: [],
          planEntries: [],
          pendingPermissionsByRequestId: {
            "perm-1": {
              requestId: "perm-1",
              toolName: "bash",
              description: "ls",
              params: {},
            },
          },
          errorMessage: null,
          errorDetails: null,
          lastUpdate: 0,
          active: true,
          streamId: "s1",
        },
      },
    } as never);
  });

  it("surfaces v2 ACP permission activity on the session list", () => {
    const { result } = renderHook(() => useSessionListActivityMap("sess-a"));
    expect(result.current.get("sess-a")).toEqual(
      expect.objectContaining({
        state: "waiting",
        kind: "permission",
      }),
    );
  });
});

describe("buildSessionListActivityMap v2 permission merge", () => {
  it("dedupes legacy and acp permissions by id", () => {
    const map = buildSessionListActivityMap({
      sessions: [{ id: "sess-a", title: "A", messages: [], updatedAt: new Date(), createdAt: new Date() }],
      activeSessionId: "sess-a",
      sessionStatuses: {},
      pendingQuestionIdsBySession: {},
      pendingQuestions: [],
      pendingPermissions: [
        {
          permission: { id: "perm-1", sessionID: "sess-a", permission: "bash" },
          childSessionId: null,
        },
        {
          permission: { id: "perm-2", sessionID: "sess-a", permission: "write" },
          childSessionId: null,
        },
      ],
      streamingMessageId: null,
      streamingChildSessionIds: [],
    });
    expect(map.get("sess-a")?.kind).toBe("permission");
  });
});
