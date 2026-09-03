import { describe, it, expect } from "vitest";
import { collectSessionAttachments } from "@/lib/attachments/session-attachments";
import type { Message } from "@/lib/proto/teamclu_pb";

function msg(content: string, createdAt = 100, attachmentUrls?: string[]): Message {
  return {
    content,
    createdAt: BigInt(createdAt),
    metadataJson: attachmentUrls
      ? JSON.stringify({ attachment_urls: attachmentUrls })
      : "",
  } as Message;
}

describe("collectSessionAttachments", () => {
  it("parses image and attachment url tokens and dedupes by url", () => {
    const messages = [
      msg(
        "[Image: a.png] (url: https://cdn.example.test/a.png)\n\n[Attachment: doc.pdf] (url: https://cdn.example.test/doc.pdf)",
        200,
      ),
      msg("[Image: a.png] (url: https://cdn.example.test/a.png)", 100),
    ];

    const out = collectSessionAttachments(messages);
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe("a.png");
    expect(out[0].url).toBe("https://cdn.example.test/a.png");
    expect(out[0].isImage).toBe(true);
    expect(out[1].name).toBe("doc.pdf");
    expect(out[1].isImage).toBe(false);
  });

  it("falls back to metadata attachment_urls when body has no token", () => {
    const url = "https://cdn.example.test/meta-only.bin";
    const out = collectSessionAttachments([
      msg("", 50, [url]),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe(url);
    expect(out[0].name).toBe("meta-only.bin");
  });
});
