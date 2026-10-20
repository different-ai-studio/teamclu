import test from "node:test";
import assert from "node:assert/strict";
import {
  dedupeSessionAttachments,
  extractSessionAttachmentsFromMessage,
  normalizeAttachmentUrl,
  parseStoragePathFromAttachmentUrl,
} from "../src/lib/session-attachments/extract-from-metadata.js";
import {
  aggregateSessionAttachmentsFromMessages,
  paginateSessionAttachments,
} from "../src/lib/session-attachments/aggregate-list.js";

test("normalizeAttachmentUrl strips query and fragment", () => {
  assert.equal(
    normalizeAttachmentUrl("https://x/a.png?token=1#frag"),
    "https://x/a.png",
  );
});

test("parseStoragePathFromAttachmentUrl reads supabase public path", () => {
  assert.equal(
    parseStoragePathFromAttachmentUrl(
      "https://supabase.example.com/storage/v1/object/public/attachments/team/s/file.png",
    ),
    "team/s/file.png",
  );
});

test("human message reads attachment_urls from metadata", () => {
  const items = extractSessionAttachmentsFromMessage({
    id: "m1",
    kind: "text",
    senderActorId: "actor-1",
    createdAt: "2026-05-27T01:00:00Z",
    metadata: {
      attachment_urls: ["https://cdn.example.com/storage/v1/object/public/attachments/t/s/a.png?sig=1"],
    },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].filename, "a.png");
  assert.equal(items[0].storagePath, "t/s/a.png");
  assert.equal(items[0].url, "https://cdn.example.com/storage/v1/object/public/attachments/t/s/a.png");
});

test("agent_reply reads attachments array and pairs urls", () => {
  const items = extractSessionAttachmentsFromMessage({
    id: "m2",
    kind: "agent_reply",
    senderActorId: "agent-1",
    createdAt: "2026-05-27T02:00:00Z",
    metadata: {
      attachment_urls: ["https://cdn.example.com/storage/v1/object/public/attachments/t/s/r.pdf"],
      attachments: [{ filename: "r.pdf", mime: "application/pdf", size: 42, bucket_path: "t/s/r.pdf" }],
    },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].filename, "r.pdf");
  assert.equal(items[0].mime, "application/pdf");
  assert.equal(items[0].size, 42);
  assert.equal(items[0].storagePath, "t/s/r.pdf");
});

test("dedupe keeps newest attachedAt for same storagePath", () => {
  const merged = dedupeSessionAttachments([
    {
      filename: "old.png",
      mime: null,
      size: null,
      storagePath: "t/s/x.png",
      url: "https://x/old.png",
      messageId: "m-old",
      senderActorId: "a1",
      attachedAt: "2026-05-27T01:00:00Z",
    },
    {
      filename: "new.png",
      mime: null,
      size: null,
      storagePath: "t/s/x.png",
      url: "https://x/new.png",
      messageId: "m-new",
      senderActorId: "a1",
      attachedAt: "2026-05-27T03:00:00Z",
    },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].messageId, "m-new");
});

test("aggregate + paginate returns newest page first", () => {
  const sorted = aggregateSessionAttachmentsFromMessages([
    {
      id: "m1",
      kind: "text",
      senderActorId: "a1",
      createdAt: "2026-05-27T01:00:00Z",
      metadata: { attachment_urls: ["https://x/a.png"] },
    },
    {
      id: "m2",
      kind: "text",
      senderActorId: "a1",
      createdAt: "2026-05-27T02:00:00Z",
      metadata: { attachment_urls: ["https://x/b.png"] },
    },
  ]);
  const page1 = paginateSessionAttachments(sorted, null, 1);
  assert.equal(page1.items.length, 1);
  assert.equal(page1.items[0].filename, "b.png");
  assert.ok(page1.nextCursor);
  const page2 = paginateSessionAttachments(sorted, page1.nextCursor, 1);
  assert.equal(page2.items[0].filename, "a.png");
});
