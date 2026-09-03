import { describe, expect, it } from "vitest";
import { createAttachmentsModule } from "@/lib/backend/cloud-api/attachments";

describe("cloud api attachments", () => {
  it("maps upload response url field to signedUrl", async () => {
    const calls: Array<{ path: string; body: BodyInit; contentType?: string }> = [];
    const attachments = createAttachmentsModule({
      async postRaw(path, body, options) {
        calls.push({ path, body, contentType: options?.contentType });
        return {
          path: "team-1/session-1/file-id/photo.png",
          url: "https://cdn.example.test/photo.png",
        };
      },
    } as never);

    const file = {
      name: "photo.png",
      type: "image/png",
      size: 9,
      arrayBuffer: async () => new TextEncoder().encode("png-bytes").buffer,
    } as File;
    const result = await attachments.uploadAttachment({
      file,
      teamId: "team-1",
      sessionId: "session-1",
    });

    expect(result.signedUrl).toBe("https://cdn.example.test/photo.png");
    expect(result.fileName).toBe("photo.png");
    expect(calls[0]?.path).toContain("/v1/attachments?path=");
    expect(calls[0]?.contentType).toBe("image/png");
  });
});
