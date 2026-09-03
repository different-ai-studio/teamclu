import { describe, expect, it } from "vitest";

import {
  collectSessionAttachmentUrlsFromText,
  encodeSessionAttachmentToken,
  expandSessionAttachmentTokensInText,
  normalizeAttachmentUrl,
  parseSessionAttachmentToken,
  parseSessionAttachmentTokensFromText,
  parseStoragePathFromAttachmentUrl,
  resolveSessionAttachmentUrl,
  textHasSessionAttachmentTokens,
} from "@/lib/attachments/session-attachment-token";

describe("session-attachment-token", () => {
  const ref = {
    name: "hiclaw-install.log",
    url: "https://example.com/files/hiclaw-install.log",
    isImage: false,
  };

  it("round-trips encode and parse", () => {
    const token = encodeSessionAttachmentToken(ref);
    expect(token.startsWith("@{att:b64:")).toBe(true);
    expect(parseSessionAttachmentToken(token)).toEqual(ref);
  });

  it("expands inline tokens for send", () => {
    const token = encodeSessionAttachmentToken(ref);
    const text = `see ${token} please`;
    expect(expandSessionAttachmentTokensInText(text)).toBe(
      `see [Attachment: hiclaw-install.log] (url: ${ref.url}) please`,
    );
  });

  it("expands image tokens", () => {
    const token = encodeSessionAttachmentToken({
      name: "shot.png",
      url: "https://example.com/shot.png",
      isImage: true,
    });
    expect(expandSessionAttachmentTokensInText(token)).toBe(
      "[Image: shot.png] (url: https://example.com/shot.png)",
    );
  });

  it("collects unique urls from text", () => {
    const token = encodeSessionAttachmentToken(ref);
    const text = `${token} ${token}`;
    expect(parseSessionAttachmentTokensFromText(text)).toHaveLength(1);
    expect(collectSessionAttachmentUrlsFromText(text)).toEqual([ref.url]);
    expect(textHasSessionAttachmentTokens(text)).toBe(true);
    expect(textHasSessionAttachmentTokens("hello")).toBe(false);
  });

  it("strips signed-url query params when expanding tokens", () => {
    const staleUrl =
      "https://supabase.example/storage/v1/object/public/attachments/t/s/id/doc.pdf?token=expired";
    const token = encodeSessionAttachmentToken({
      name: "doc.pdf",
      url: staleUrl,
      isImage: false,
      path: "t/s/id/doc.pdf",
    });
    expect(expandSessionAttachmentTokensInText(token)).toBe(
      "[Attachment: doc.pdf] (url: https://supabase.example/storage/v1/object/public/attachments/t/s/id/doc.pdf)",
    );
    expect(collectSessionAttachmentUrlsFromText(token)).toEqual([
      "https://supabase.example/storage/v1/object/public/attachments/t/s/id/doc.pdf",
    ]);
  });

  it("normalizes attachment urls and parses storage paths", () => {
    const url =
      "https://supabase.example/storage/v1/object/public/attachments/team/s/file.png?sig=abc#frag";
    expect(normalizeAttachmentUrl(url)).toBe(
      "https://supabase.example/storage/v1/object/public/attachments/team/s/file.png",
    );
    expect(parseStoragePathFromAttachmentUrl(url)).toBe("team/s/file.png");
    expect(
      resolveSessionAttachmentUrl({
        url,
        path: "team/s/file.png",
      }),
    ).toBe(
      "https://supabase.example/storage/v1/object/public/attachments/team/s/file.png",
    );
  });
});
