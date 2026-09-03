import { describe, expect, it, beforeEach } from "vitest";

import {
  getCachedAttachmentPath,
  normalizeAttachmentUrlKey,
  removeCachedAttachmentPath,
  setCachedAttachmentPath,
} from "@/lib/attachments/attachment-download-index";

describe("attachment-download-index", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("normalizes signed URLs to origin + pathname", () => {
    expect(
      normalizeAttachmentUrlKey(
        "https://cdn.example.test/attachments/t/s/a.pdf?token=abc",
      ),
    ).toBe("https://cdn.example.test/attachments/t/s/a.pdf");
  });

  it("persists saved paths in localStorage", () => {
    const key = normalizeAttachmentUrlKey("https://cdn.example.test/a.pdf?sig=1");
    setCachedAttachmentPath(key, "/Users/me/Downloads/a.pdf", "a.pdf");
    expect(getCachedAttachmentPath(key)).toBe("/Users/me/Downloads/a.pdf");
    removeCachedAttachmentPath(key);
    expect(getCachedAttachmentPath(key)).toBeNull();
  });
});
