import { describe, expect, it } from "vitest";
import {
  buildSessionListActivityMap,
  resolveSessionActivityOwner,
} from "@/lib/session/session-list-activity";

describe("session-list-activity", () => {
  const sessions = [
    { id: "parent-1", title: "Parent", messages: [], updatedAt: new Date(), createdAt: new Date() },
    { id: "child-1", title: "Child", parentID: "parent-1", messages: [], updatedAt: new Date(), createdAt: new Date() },
    { id: "standalone", title: "Standalone", messages: [], updatedAt: new Date(), createdAt: new Date() },
  ];

  it("attributes child session activity to the parent session", () => {
    expect(resolveSessionActivityOwner("child-1", sessions, "child-1")).toBe("parent-1");
  });

  it("returns no entries for static sessions", () => {
    const map = buildSessionListActivityMap({
      sessions,
      activeSessionId: "standalone",
      sessionStatuses: {},
      pendingQuestionIdsBySession: {},
      pendingQuestions: [],
      pendingPermissions: [],
      streamingMessageId: null,
      streamingChildSessionIds: [],
    });

    expect(map.size).toBe(0);
  });

  it("shows question activity on the parent when the child is waiting", () => {
    const map = buildSessionListActivityMap({
      sessions,
      activeSessionId: "parent-1",
      sessionStatuses: {},
      pendingQuestionIdsBySession: { "child-1": ["tc-1"] },
      pendingQuestions: [
        {
          questionId: "q-event",
          toolCallId: "tc-1",
          messageId: "msg-1",
          sessionId: "child-1",
          questions: [{ question: "Continue?", options: [] }],
        },
      ],
      pendingPermissions: [],
      streamingMessageId: null,
      streamingChildSessionIds: [],
    });

    expect(map.get("parent-1")).toEqual(
      expect.objectContaining({
        state: "waiting",
        kind: "question",
        count: 1,
      }),
    );
  });

  it("attributes parent permission activity to the permission session instead of the active session", () => {
    const map = buildSessionListActivityMap({
      sessions,
      activeSessionId: "parent-1",
      sessionStatuses: {},
      pendingQuestionIdsBySession: {},
      pendingQuestions: [],
      pendingPermissions: [
        {
          childSessionId: null,
          permission: {
            id: "perm-1",
            sessionID: "standalone",
            permission: "bash",
          },
        },
      ],
      streamingMessageId: null,
      streamingChildSessionIds: [],
    });

    expect(map.get("standalone")).toEqual(
      expect.objectContaining({
        state: "waiting",
        kind: "permission",
      }),
    );
    expect(map.get("parent-1")).toBeUndefined();
  });

  it("attributes unknown child permission activity to its stored owner session", () => {
    const map = buildSessionListActivityMap({
      sessions,
      activeSessionId: "standalone",
      sessionStatuses: {
        "parent-1": { type: "busy" },
      },
      pendingQuestionIdsBySession: {},
      pendingQuestions: [],
      pendingPermissions: [
        {
          childSessionId: "child-not-yet-loaded",
          ownerSessionId: "parent-1",
          permission: {
            id: "perm-child",
            sessionID: "child-not-yet-loaded",
            permission: "bash",
          },
        },
      ],
      streamingMessageId: null,
      streamingChildSessionIds: [],
    });

    expect(map.get("parent-1")).toEqual(
      expect.objectContaining({
        state: "waiting",
        kind: "permission",
      }),
    );
    expect(map.get("child-not-yet-loaded")).toBeUndefined();
  });
});
