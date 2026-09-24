import { describe, expect, it } from "vitest";

import { buildSessionFeedSources } from "../features/sessions/session-feed-items";
import type { SessionMessage, StreamingBuffer } from "../features/sessions/session-types";

function message(
  id: string,
  kind: string,
  content: string,
  createdAt: string,
  senderActorId = "agent-1",
  turnId = "",
): SessionMessage {
  return {
    content,
    createdAt,
    kind,
    messageId: id,
    metadata: null,
    model: kind === "agent_reply" ? "gpt-5.2" : "",
    replyToMessageId: "",
    senderActorId,
    sessionId: "session-1",
    teamId: "team-1",
    turnId,
  };
}

describe("buildSessionFeedSources", () => {
  it("groups runtime detail and the final agent reply into one completed turn", () => {
    const sources = buildSessionFeedSources(
      [
        message("user-1", "text", "Please inspect this", "2026-05-20T10:00:00.000Z", "me"),
        message("think-1", "agent_thinking", "I should inspect the files", "2026-05-20T10:00:01.000Z"),
        message("tool-1", "agent_tool_call", "rg query", "2026-05-20T10:00:02.000Z"),
        message("result-1", "agent_tool_result", "3 matches", "2026-05-20T10:00:03.000Z"),
        message("plan-1", "plan_update", "[wip] implement", "2026-05-20T10:00:04.000Z"),
        message("reply-1", "agent_reply", "Done.", "2026-05-20T10:00:05.000Z"),
      ],
      new Map(),
      { ownActorId: "me" },
    );

    expect(sources.map((item) => item.kind)).toEqual(["message", "agentTurn"]);
    expect(sources[1]).toMatchObject({
      kind: "agentTurn",
      turn: {
        agentId: "agent-1",
        isActive: false,
        finalMessage: expect.objectContaining({ messageId: "reply-1" }),
        runtimeEvents: [
          expect.objectContaining({ messageId: "think-1" }),
          expect.objectContaining({ messageId: "tool-1" }),
          expect.objectContaining({ messageId: "result-1" }),
          expect.objectContaining({ messageId: "plan-1" }),
        ],
      },
    });
  });

  it("keeps permission requests in the main feed while grouping surrounding runtime detail", () => {
    const sources = buildSessionFeedSources(
      [
        message("think-1", "agent_thinking", "Need permission", "2026-05-20T10:00:01.000Z"),
        message("perm-1", "permission_request", "Allow file write?", "2026-05-20T10:00:02.000Z"),
        message("result-1", "agent_tool_result", "Permission granted", "2026-05-20T10:00:03.000Z"),
        message("reply-1", "agent_reply", "Finished.", "2026-05-20T10:00:04.000Z"),
      ],
      new Map(),
    );

    expect(sources.map((item) => item.kind)).toEqual(["message", "agentTurn"]);
    expect(sources[0]).toMatchObject({
      kind: "message",
      message: expect.objectContaining({ messageId: "perm-1" }),
    });
    expect(sources[1]).toMatchObject({
      kind: "agentTurn",
      turn: {
        runtimeEvents: [
          expect.objectContaining({ messageId: "think-1" }),
          expect.objectContaining({ messageId: "result-1" }),
        ],
      },
    });
  });

  it("creates one active turn for open runtime events plus the live stream buffer", () => {
    const stream: StreamingBuffer = {
      isComplete: false,
      kind: "agent_reply",
      messageId: "stream-1",
      model: "gpt-5.2",
      senderActorId: "agent-1",
      startedAt: "2026-05-20T10:00:02.000Z",
      text: "Partial response",
    };

    const sources = buildSessionFeedSources(
      [
        message("think-1", "agent_thinking", ".", "2026-05-20T10:00:01.000Z"),
        message("tool-1", "agent_tool_call", "read file", "2026-05-20T10:00:02.000Z"),
      ],
      new Map([["agent-1", stream]]),
    );

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      kind: "agentTurn",
      turn: {
        agentId: "agent-1",
        isActive: true,
        runtimeEvents: [
          expect.objectContaining({ messageId: "think-1" }),
          expect.objectContaining({ messageId: "tool-1" }),
        ],
        stream: expect.objectContaining({ text: "Partial response" }),
      },
    });
  });

  it("stops showing a turn as active once its stream has closed", () => {
    // The daemon's own follow-up turns (retitling the session) stream output
    // that is never committed as a reply; on idle the stream is closed, and
    // the card must stop saying "replying".
    const closed: StreamingBuffer = {
      isComplete: true,
      kind: "agent_reply",
      messageId: "stream-2",
      model: "m",
      senderActorId: "agent-1",
      startedAt: "2026-05-20T10:00:02.000Z",
      text: "Reply only to the user prompt",
    };
    const sources = buildSessionFeedSources([], new Map([["agent-1", closed]]));
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ kind: "agentTurn", turn: { isActive: false } });
  });

  it("merges split final agent replies that share the same turn id", () => {
    const sources = buildSessionFeedSources(
      [
        message("think-1", "agent_thinking", "I will use a tool", "2026-05-20T10:00:01.000Z", "agent-1", "turn-1"),
        message("reply-1", "agent_reply", "First part. ", "2026-05-20T10:00:02.000Z", "agent-1", "turn-1"),
        message("reply-2", "agent_reply", "Second part.", "2026-05-20T10:00:03.000Z", "agent-1", "turn-1"),
      ],
      new Map(),
    );

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      kind: "agentTurn",
      key: "agentTurn:agent-1:turn-1",
      turn: {
        finalMessage: expect.objectContaining({
          content: "First part. Second part.",
          messageId: "reply-2",
        }),
        runtimeEvents: [expect.objectContaining({ messageId: "think-1" })],
      },
    });
  });

  it("exposes the daemon turn id only when a message actually carried one", () => {
    const withTurnId = buildSessionFeedSources(
      [
        message("think-1", "agent_thinking", "…", "2026-05-20T10:00:01.000Z", "agent-1", "turn-7"),
        message("reply-1", "agent_reply", "Done.", "2026-05-20T10:00:02.000Z", "agent-1", "turn-7"),
      ],
      new Map(),
    );
    expect(withTurnId[0]).toMatchObject({ turn: { daemonTurnId: "turn-7", id: "turn-7" } });

    const synthetic = buildSessionFeedSources(
      [message("reply-1", "agent_reply", "Done.", "2026-05-20T10:00:02.000Z")],
      new Map(),
    );
    // No `turnId` on the wire → the feed key falls back to `turn:<messageId>`,
    // which the daemon would not recognise, so daemonTurnId stays undefined.
    expect(synthetic[0]).toMatchObject({ turn: { id: "turn:reply-1" } });
    expect(
      synthetic[0].kind === "agentTurn" ? synthetic[0].turn.daemonTurnId : "unset",
    ).toBeUndefined();
  });

  it("picks up the daemon turn id from an open turn's runtime events", () => {
    const sources = buildSessionFeedSources(
      [
        message("think-1", "agent_thinking", "…", "2026-05-20T10:00:01.000Z", "agent-1", "turn-8"),
      ],
      new Map(),
    );
    expect(sources[0]).toMatchObject({ turn: { daemonTurnId: "turn-8", isActive: true } });
  });
});
