import { describe, expect, it } from "vitest";
import { historyRowsToMessageRows } from "@/lib/messages/message-history-map";

describe("historyRowsToMessageRows", () => {
  it("maps reply_to and metadata", () => {
    const rows = historyRowsToMessageRows(
      [
        {
          id: "m1",
          team_id: "t1",
          session_id: "s1",
          turn_id: "turn-1",
          sender_actor_id: "a1",
          reply_to_message_id: "parent-1",
          kind: "agent_reply",
          content: "Done.",
          metadata: { foo: 1 },
          model: "deepseek",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: null,
        },
      ],
      { origin: "cloud_api" },
    );
    expect(rows[0]?.replyToMessageId).toBe("parent-1");
    expect(rows[0]?.turnId).toBe("turn-1");
    expect(rows[0]?.metadataJson).toBe('{"foo":1}');
    expect(rows[0]?.origin).toBe("cloud_api");
  });
});
