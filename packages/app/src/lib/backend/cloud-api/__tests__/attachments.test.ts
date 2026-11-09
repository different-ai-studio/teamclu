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
    const stored = new URL(calls[0].path, "https://example.test").searchParams.get("path");
    expect(stored).toMatch(/^team-1\/session-1\/[0-9a-f-]+\/photo\.png$/);
  });

  it("stores a Chinese PDF under an ASCII key and keeps the display name", async () => {
    const calls: Array<{ path: string; contentType?: string }> = [];
    const attachments = createAttachmentsModule({
      async postRaw(path: string, _body: BodyInit, options?: { contentType?: string }) {
        calls.push({ path, contentType: options?.contentType });
        return { path: "stored", url: "https://cdn.example.test/AI.pdf" };
      },
    } as never);

    const file = {
      name: "AI升级能力地图方案.pdf",
      type: "application/pdf",
      size: 579931,
      arrayBuffer: async () => new TextEncoder().encode("pdf").buffer,
    } as File;
    const result = await attachments.uploadAttachment({
      file,
      teamId: "30b7006d-4225-4160-8c12-0a057268a914",
      sessionId: "e8a6039b-602a-4102-a7c2-a0f0589ef049",
    });

    expect(result.fileName).toBe("AI升级能力地图方案.pdf");
    expect(result.signedUrl).toBe("https://cdn.example.test/AI.pdf");
    const stored = new URL(calls[0].path, "https://example.test").searchParams.get("path");
    expect(stored).toMatch(
      /^30b7006d-4225-4160-8c12-0a057268a914\/e8a6039b-602a-4102-a7c2-a0f0589ef049\/[0-9a-f-]+\/AI\.pdf$/,
    );
    expect(stored).not.toContain("升级");
    expect(calls[0]?.contentType).toBe("application/pdf");
  });

  it("stores a Chinese PowerPoint under an ASCII key as octet-stream", async () => {
    const calls: Array<{ path: string; contentType?: string }> = [];
    const attachments = createAttachmentsModule({
      async postRaw(path: string, _body: BodyInit, options?: { contentType?: string }) {
        calls.push({ path, contentType: options?.contentType });
        return { url: "https://cdn.example.test/deck.ppt" };
      },
    } as never);

    const file = {
      name: "物流与云仓-TeamClu-AI升级方向方案-V0.1.ppt",
      type: "application/vnd.ms-powerpoint",
      size: 426_000,
      arrayBuffer: async () => new ArrayBuffer(4),
    } as File;
    const result = await attachments.uploadAttachment({
      file,
      teamId: "team-1",
      sessionId: "session-1",
    });

    expect(result.fileName).toBe("物流与云仓-TeamClu-AI升级方向方案-V0.1.ppt");
    const stored = new URL(calls[0].path, "https://example.test").searchParams.get("path");
    expect(stored).toMatch(/^team-1\/session-1\/[0-9a-f-]+\/-TeamClu-AI_-V0\.1\.ppt$/);
    expect(calls[0]?.contentType).toBe("application/octet-stream");
  });
});
