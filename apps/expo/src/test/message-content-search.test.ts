import { afterEach, describe, expect, it } from "vitest";

import { saveMessages } from "../lib/db/local-cache";
import { loadSearchableMessages } from "../lib/db/local-cache";
import { sessionIdsMatchingMessages } from "../features/sessions/message-actions";
import { createMemoryCacheDb } from "./helpers/memory-db";

let db: ReturnType<typeof createMemoryCacheDb> | null = null;
afterEach(() => db?.close());

const row = (id: string, sessionId: string, kind: string, content: string, teamId = "t1") => ({
  messageId: id, sessionId, teamId, senderActorId: "a", kind, content, model: "", turnId: "",
  replyToMessageId: "", metadata: null, attachments: [], createdAt: "2026-10-14T00:00:00Z",
});

describe("search by cached message content", () => {
  it("finds sessions by chat text and agent replies, in this team only", async () => {
    db = createMemoryCacheDb();
    await saveMessages(db, "s1", [row("m1", "s1", "text", "please DOUBLE it")]);
    await saveMessages(db, "s2", [
      row("m2", "s2", "agent_thinking", "double check"),
      row("m3", "s2", "agent_reply", "nothing here"),
    ]);
    await saveMessages(db, "s3", [row("m4", "s3", "agent_reply", "doubled: 22")]);
    await saveMessages(db, "s4", [row("m5", "s4", "text", "double", "t2")]);

    const rows = await loadSearchableMessages(db, "t1");
    expect([...sessionIdsMatchingMessages(rows, "double")].sort()).toEqual(["s1", "s3"]);
    expect(sessionIdsMatchingMessages(rows, "d").size).toBe(0);
  });
});
