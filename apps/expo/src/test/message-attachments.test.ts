import { describe, expect, it } from "vitest";

import {
  attachmentMetadata,
  attachmentsFromMessage,
  bucketPathFromAttachmentUrl,
} from "../features/sessions/message-attachments";
import { mapMessageRecord } from "../features/sessions/session-types";

const PUBLIC_URL =
  "https://supabase.example.test/storage/v1/object/public/attachments/team-1/session-1/a.png";

describe("bucketPathFromAttachmentUrl", () => {
  it("reads the path after the bucket segment of storage and OSS URLs", () => {
    expect(bucketPathFromAttachmentUrl(PUBLIC_URL)).toBe("team-1/session-1/a.png");
    expect(bucketPathFromAttachmentUrl("https://oss.test/attachments/attachments/t/s/b.jpg?x=1")).toBe("t/s/b.jpg");
    expect(bucketPathFromAttachmentUrl("https://elsewhere.test/a.png")).toBeNull();
  });
});

describe("attachmentMetadata", () => {
  it("writes the iOS refs and the desktop URL list", () => {
    expect(attachmentMetadata([
      { url: PUBLIC_URL, path: "team-1/session-1/a.png", mime: "image/png", size: 42 },
    ])).toEqual({
      attachments: [{ filename: "a.png", mime: "image/png", size: 42, bucket_path: "team-1/session-1/a.png" }],
      attachment_urls: [PUBLIC_URL],
    });
  });

  it("adds nothing for a message without files", () => {
    expect(attachmentMetadata(undefined)).toEqual({});
    expect(attachmentMetadata([])).toEqual({});
  });
});

describe("attachmentsFromMessage", () => {
  it("round-trips what Expo writes", () => {
    const metadata = attachmentMetadata([
      { url: PUBLIC_URL, path: "team-1/session-1/a.png", mime: "image/png", size: 42 },
    ]);
    expect(attachmentsFromMessage(metadata, null, "https://api.test")).toEqual([
      { url: PUBLIC_URL, path: "team-1/session-1/a.png", mime: "image/png", size: 42 },
    ]);
  });

  it("serves an iOS upload, known only by its bucket path, through the Cloud API", () => {
    const metadata = {
      attachments: [{ filename: "IMG.jpg", mime: "image/jpeg", size: 7, bucket_path: "t/s/u/IMG.jpg" }],
    };
    expect(attachmentsFromMessage(metadata, null, "https://api.test/")).toEqual([
      { url: "https://api.test/v1/attachments/t%2Fs%2Fu%2FIMG.jpg", path: "t/s/u/IMG.jpg", mime: "image/jpeg", size: 7 },
    ]);
    expect(attachmentsFromMessage(metadata, null, null)).toBeUndefined();
  });

  it("reads a desktop message's URL list", () => {
    expect(attachmentsFromMessage({ attachment_urls: [PUBLIC_URL] }, null, null)).toEqual([
      { url: PUBLIC_URL, path: "team-1/session-1/a.png", mime: "image/png" },
    ]);
  });

  it("falls back to an already-mapped list (local cache rows)", () => {
    expect(attachmentsFromMessage(null, [{ url: "https://x.test/a.png", mime: "image/png" }], null)).toEqual([
      { url: "https://x.test/a.png", path: undefined, mime: "image/png", size: null },
    ]);
  });

  it("is what a history row maps to", () => {
    const message = mapMessageRecord({
      id: "m1", team_id: "t", session_id: "s", turn_id: null, sender_actor_id: "a",
      reply_to_message_id: null, kind: "text", content: "", model: null, created_at: "",
      metadata: { mention_actor_ids: [], attachment_urls: [PUBLIC_URL] },
    });
    expect(message.attachments?.[0]?.url).toBe(PUBLIC_URL);
  });
});
