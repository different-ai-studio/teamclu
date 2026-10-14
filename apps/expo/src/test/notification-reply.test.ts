import { describe, expect, it, vi } from "vitest";

import {
  replyRequestFromResponse,
  sendNotificationReply,
  SESSION_REPLY_ACTION,
  type NotificationReplyDeps,
} from "../features/notifications/notification-reply";

function response(data: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    actionIdentifier: SESSION_REPLY_ACTION,
    userText: "  Add 1 to that ",
    notification: { request: { identifier: "n1", content: { data } } },
    ...overrides,
  };
}

const data = {
  session_id: "s1",
  team_id: "t1",
  message_id: "m1",
  sender_actor_id: "agent-1",
  sender_kind: "agent",
};

describe("replyRequestFromResponse", () => {
  it("reads the reply text and what it needs to post it", () => {
    expect(replyRequestFromResponse(response(data))).toEqual({
      sessionId: "s1",
      teamId: "t1",
      messageId: "m1",
      senderActorId: "agent-1",
      senderIsAgent: true,
      text: "Add 1 to that",
    });
  });

  it("ignores taps, empty replies and payloads without a team", () => {
    expect(replyRequestFromResponse(response(data, { actionIdentifier: "expo.modules.notifications.actions.DEFAULT" }))).toBeNull();
    expect(replyRequestFromResponse(response(data, { userText: "  " }))).toBeNull();
    expect(replyRequestFromResponse(response({ ...data, team_id: null }))).toBeNull();
  });
});

function deps(overrides: Partial<NotificationReplyDeps> = {}): NotificationReplyDeps {
  return {
    getUserId: async () => "user-1",
    resolveMemberActorId: async () => "member-1",
    insertOutgoingMessage: vi.fn(async () => {}),
    saveDraft: vi.fn(async () => {}),
    notifyFailure: vi.fn(async () => {}),
    now: () => new Date("2026-10-14T00:00:00.000Z"),
    ...overrides,
  };
}

describe("sendNotificationReply", () => {
  it("posts a quoting reply that @s an agent sender", async () => {
    const d = deps();
    const request = replyRequestFromResponse(response(data))!;
    await expect(sendNotificationReply(request, d)).resolves.toBe("sent");
    expect(d.insertOutgoingMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "t1",
        sessionId: "s1",
        senderActorId: "member-1",
        content: "Add 1 to that",
        metadata: { mention_actor_ids: ["agent-1"] },
        replyToMessageId: "m1",
      }),
    );
  });

  it("does not @ a member sender", async () => {
    const d = deps();
    const request = replyRequestFromResponse(response({ ...data, sender_kind: "member" }))!;
    await sendNotificationReply(request, d);
    expect(d.insertOutgoingMessage).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { mention_actor_ids: [] } }),
    );
  });

  it("keeps the text as a draft and says so when the reply cannot be sent", async () => {
    const d = deps({ insertOutgoingMessage: vi.fn(async () => { throw new Error("401"); }) });
    const request = replyRequestFromResponse(response(data))!;
    await expect(sendNotificationReply(request, d)).resolves.toBe("savedAsDraft");
    expect(d.saveDraft).toHaveBeenCalledWith("s1", "Add 1 to that");
    expect(d.notifyFailure).toHaveBeenCalledWith("s1");
  });
});
