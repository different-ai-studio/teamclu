import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  fetchAgentReplyAttachmentBytes,
  storagePathFromPublicAttachmentUrl,
} from "@/lib/attachments/download-remote-attachment";

const downloadByStoragePath = vi.fn(async () => ({
  bytes: new Uint8Array([9, 9, 9]),
  contentType: "text/plain",
}));

vi.mock("@/lib/backend/provider", () => ({
  getBackend: () => ({
    attachments: { downloadByStoragePath },
  }),
}));

describe("storagePathFromPublicAttachmentUrl", () => {
  it("parses Supabase public attachments URL", () => {
    const path = storagePathFromPublicAttachmentUrl(
      "https://copilot.example.test/storage/v1/object/public/attachments/team-1/sess/a/file.txt",
    );
    expect(path).toBe("team-1/sess/a/file.txt");
  });
});

describe("fetchAgentReplyAttachmentBytes", () => {
  beforeEach(() => {
    downloadByStoragePath.mockClear();
  });

  it("prefers Cloud API when metadata bucket_path is present", async () => {
    const out = await fetchAgentReplyAttachmentBytes({
      filename: "file.txt",
      mime: "text/plain",
      size: 3,
      url: "https://copilot.example.test/storage/v1/object/public/attachments/ignored",
      bucketPath: "team-1/sess/a/file.txt",
      isImage: false,
    });
    expect(downloadByStoragePath).toHaveBeenCalledWith("team-1/sess/a/file.txt");
    expect(out.bytes).toEqual(new Uint8Array([9, 9, 9]));
  });

  it("derives storage path from public URL when bucket_path is missing", async () => {
    await fetchAgentReplyAttachmentBytes({
      filename: "file.txt",
      mime: "text/plain",
      size: 3,
      url: "https://copilot.example.test/storage/v1/object/public/attachments/team-1/sess/a/file.txt",
      isImage: false,
    });
    expect(downloadByStoragePath).toHaveBeenCalledWith("team-1/sess/a/file.txt");
  });
});
