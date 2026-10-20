import { describe, expect, it } from "vitest";

import {
  canDeleteSelection,
  composeTranscript,
  feedSearchMatches,
  promptForTurn,
  selectedMessages,
} from "../features/sessions/message-actions";
import { buildSessionFeedSources } from "../features/sessions/session-feed-items";
import type { SessionMessage } from "../features/sessions/session-types";

function message(
  id: string,
  kind: string,
  content: string,
  minute: number,
  senderActorId = "agent-1",
  extra: Partial<SessionMessage> = {},
): SessionMessage {
  return {
    content,
    createdAt: new Date(Date.UTC(2026, 9, 14, 10, minute)).toISOString(),
    kind,
    messageId: id,
    metadata: null,
    model: "",
    replyToMessageId: "",
    senderActorId,
    sessionId: "s1",
    teamId: "t1",
    turnId: "",
    ...extra,
  };
}

const feed = buildSessionFeedSources(
  [
    message("u1", "text", "What is Café au lait?", 0, "me"),
    message("think", "agent_thinking", "café secret", 1),
    message("r1", "agent_reply", "A coffee with milk", 2),
    message("u2", "text", "Double it", 3, "me", { replyToMessageId: "r1" }),
    message("r2", "agent_reply", "Two coffees", 4),
    message("u3", "text", "See this", 5, "me", {
      attachments: [{ url: "x", path: "p", mime: "image/png", size: 1 }],
    }),
    message("r3", "agent_reply", "Nice picture", 6),
  ],
  new Map(),
  { ownActorId: "me" },
);
const keyOf = (id: string) =>
  feed.find((s) =>
    s.kind === "message" ? s.message.messageId === id : s.turn.finalMessage?.messageId === id,
  )!.key;

describe("feedSearchMatches", () => {
  it("matches displayed text ignoring case and accents, never thinking steps", () => {
    expect(feedSearchMatches(feed, "CAFE")).toEqual([keyOf("u1")]);
    expect(feedSearchMatches(feed, "coffee")).toEqual([keyOf("r1"), keyOf("r2")]);
    expect(feedSearchMatches(feed, "  ")).toEqual([]);
  });
});

describe("promptForTurn", () => {
  it("finds the chat message right above a turn", () => {
    expect(promptForTurn(feed, keyOf("r2"))?.messageId).toBe("u2");
    expect(promptForTurn(feed, keyOf("r2"))?.replyToMessageId).toBe("r1");
  });

  it("offers nothing when the prompt carried files, or for a non-turn row", () => {
    expect(promptForTurn(feed, keyOf("r3"))).toBeNull();
    expect(promptForTurn(feed, keyOf("u1"))).toBeNull();
  });
});

describe("selection", () => {
  it("returns selected messages in feed order and composes a transcript", () => {
    const picked = selectedMessages(feed, new Set([keyOf("r1"), keyOf("u1")]));
    expect(picked.map((m) => m.messageId)).toEqual(["u1", "r1"]);
    const names: Record<string, string> = { me: "Matt", "agent-1": "pi" };
    expect(
      composeTranscript(
        picked.map((m) => ({ sender: names[m.senderActorId]!, text: m.content })),
        "Forwarded from “Coffee”",
      ),
    ).toBe("Forwarded from “Coffee”\n\nMatt: What is Café au lait?\n\npi: A coffee with milk");
  });

  it("allows delete only for the reader's own, persisted messages", () => {
    const own = selectedMessages(feed, new Set([keyOf("u1"), keyOf("u2")]));
    const mixed = selectedMessages(feed, new Set([keyOf("u1"), keyOf("r1")]));
    expect(canDeleteSelection(own, "me", () => true)).toBe(true);
    expect(canDeleteSelection(own, "me", (id) => id !== "u2")).toBe(false);
    expect(canDeleteSelection(mixed, "me", () => true)).toBe(false);
    expect(canDeleteSelection([], "me", () => true)).toBe(false);
  });
});
