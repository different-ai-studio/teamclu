import { describe, expect, it } from "vitest";
import {
  agentReplyAttachmentsFromMessageFields,
  agentReplyAttachmentsFromTurnReplies,
} from "@/lib/attachments/agent-reply-attachments";
import type { Message } from "@/lib/proto/teamclu_pb";
import { MessageKind } from "@/lib/proto/teamclu_pb";

describe("agentReplyAttachmentsFromMessageFields", () => {
  it("reads metadata.attachments with proto attachment_urls", () => {
    const metadataJson = JSON.stringify({
      attachments: [
        {
          filename: "session-upload.txt",
          mime: "text/plain",
          size: 12,
          bucket_path: "team/sess/id/session-upload.txt",
        },
      ],
    });
    const out = agentReplyAttachmentsFromMessageFields(metadataJson, [
      "https://cdn.example.test/session-upload.txt",
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.filename).toBe("session-upload.txt");
    expect(out[0]?.url).toBe("https://cdn.example.test/session-upload.txt");
    expect(out[0]?.isImage).toBe(false);
  });

  it("falls back to metadata attachment_urls only", () => {
    const metadataJson = JSON.stringify({
      attachment_urls: ["https://cdn.example.test/photo.png"],
    });
    const out = agentReplyAttachmentsFromMessageFields(metadataJson, []);
    expect(out).toHaveLength(1);
    expect(out[0]?.filename).toBe("photo.png");
    expect(out[0]?.isImage).toBe(true);
  });
});

describe("agentReplyAttachmentsFromTurnReplies", () => {
  it("uses the latest reply row that carries attachments", () => {
    const early = {
      messageId: "m1",
      sessionId: "s1",
      kind: MessageKind.AGENT_REPLY,
      content: "draft",
      metadataJson: "",
      attachmentUrls: [],
    } as Message;
    const final = {
      messageId: "m2",
      sessionId: "s1",
      kind: MessageKind.AGENT_REPLY,
      content: "done",
      metadataJson: JSON.stringify({
        attachments: [{ filename: "a.pdf", mime: "application/pdf", size: 1, bucket_path: "p/a.pdf" }],
      }),
      attachmentUrls: ["https://cdn.example.test/a.pdf"],
    } as Message;
    const out = agentReplyAttachmentsFromTurnReplies([early, final]);
    expect(out?.[0]?.filename).toBe("a.pdf");
  });
});
