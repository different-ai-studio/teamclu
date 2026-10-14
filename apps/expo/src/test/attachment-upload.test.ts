import { beforeEach, describe, expect, it, vi } from "vitest";

const fileSystemMock = vi.hoisted(() => ({
  readAsStringAsync: vi.fn(),
  EncodingType: { Base64: "base64" },
}));

vi.mock("expo-file-system", () => fileSystemMock);

const BASE_URL = "https://fc.example.com";

function uploadResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("uploadAttachment", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    fileSystemMock.readAsStringAsync.mockReset();
  });

  it("POSTs raw bytes to /v1/attachments and returns the public URL", async () => {
    const { uploadAttachment } = await import("../features/sessions/attachment-upload");
    const blob = new Blob(["image-bytes"], { type: "image/png" });
    // Global fetch is used only to read the local file URI.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, blob: vi.fn().mockResolvedValue(blob) }),
    );

    const uploadFetch = vi
      .fn()
      .mockResolvedValue(
        uploadResponse({ path: "team-1/session-1/x.png", url: "https://cdn.example.test/x.png" }),
      );

    const result = await uploadAttachment({
      getAccessToken: async () => "access-token",
      teamId: "team-1",
      sessionId: "session-1",
      localUri: "file:///tmp/photo.png",
      fallbackMime: "image/png",
      baseUrl: BASE_URL,
      fetchImpl: uploadFetch as never,
    });

    expect(uploadFetch).toHaveBeenCalledTimes(1);
    const [url, init] = uploadFetch.mock.calls[0];
    expect(String(url)).toBe(
      `https://fc.example.com/v1/attachments?path=${encodeURIComponent(result.path)}&bucket=attachments`,
    );
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer access-token",
      "Content-Type": "image/png",
    });
    const uploadedBody = init?.body as ArrayBuffer;
    expect(uploadedBody).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(uploadedBody))).toEqual(
      Array.from(new Uint8Array(await blob.arrayBuffer())),
    );
    expect(result.mime).toBe("image/png");
    expect(result.publicUrl).toBe("https://cdn.example.test/x.png");
  });

  it("routes to the requested bucket and throws on a non-2xx response", async () => {
    const { uploadAttachment } = await import("../features/sessions/attachment-upload");
    const blob = new Blob(["avatar"], { type: "image/jpeg" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, blob: vi.fn().mockResolvedValue(blob) }),
    );

    const uploadFetch = vi
      .fn()
      .mockResolvedValue(uploadResponse({ error: { message: "too big" } }, 413));

    await expect(
      uploadAttachment({
        getAccessToken: async () => "access-token",
        teamId: "team-1",
        sessionId: "session-1",
        localUri: "file:///tmp/avatar.jpg",
        fallbackMime: "image/jpeg",
        bucket: "avatars",
        baseUrl: BASE_URL,
        fetchImpl: uploadFetch as never,
      }),
    ).rejects.toThrow(/too big/);

    expect(String(uploadFetch.mock.calls[0][0])).toContain("&bucket=avatars");
  });

  it("falls back to Expo FileSystem when fetch cannot read the local URI", async () => {
    const { uploadAttachment } = await import("../features/sessions/attachment-upload");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Network request failed")));
    fileSystemMock.readAsStringAsync.mockResolvedValue("aW1n");

    const uploadFetch = vi
      .fn()
      .mockResolvedValue(uploadResponse({ path: "p", url: "https://cdn.example.test/p.jpg" }));

    const result = await uploadAttachment({
      getAccessToken: async () => "access-token",
      teamId: "team-1",
      sessionId: "session-1",
      localUri: "file:///tmp/photo.jpg",
      fallbackMime: "image/jpeg",
      baseUrl: BASE_URL,
      fetchImpl: uploadFetch as never,
    });

    expect(fileSystemMock.readAsStringAsync).toHaveBeenCalledWith("file:///tmp/photo.jpg", {
      encoding: "base64",
    });
    expect(result.mime).toBe("image/jpeg");
    expect(result.size).toBe(3);
    const uploadedBody = uploadFetch.mock.calls[0][1]?.body as ArrayBuffer;
    expect(uploadedBody).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(uploadedBody))).toEqual([105, 109, 103]);
  });
});

describe("uploadPastedImage", () => {
  it("uploads the pasted bytes under the session's attachment path", async () => {
    const { uploadPastedImage, decodePastedImage } = await import(
      "../features/sessions/attachment-upload"
    );
    const png = Buffer.from("fake-png").toString("base64");
    expect(decodePastedImage(`data:image/png;base64,${png}`, "image/jpeg").mime).toBe("image/png");
    expect(decodePastedImage(png, "image/jpeg").mime).toBe("image/jpeg");

    const uploadFetch = vi.fn().mockResolvedValue(uploadResponse({ url: "https://cdn.example.test/p.png" }));
    const uploaded = await uploadPastedImage({
      getAccessToken: async () => "tok",
      teamId: "team-1",
      sessionId: "session-1",
      data: `data:image/png;base64,${png}`,
      baseUrl: BASE_URL,
      fetchImpl: uploadFetch as unknown as typeof fetch,
    });

    expect(uploaded.path).toMatch(/^team-1\/session-1\/[0-9a-f-]+\.png$/);
    expect(uploaded).toMatchObject({ publicUrl: "https://cdn.example.test/p.png", mime: "image/png", size: 8 });
    const [url, init] = uploadFetch.mock.calls[0]!;
    expect(String(url)).toContain("/v1/attachments?path=team-1%2Fsession-1%2F");
    expect((init as RequestInit).headers).toMatchObject({ "Content-Type": "image/png" });
    expect(new Uint8Array((init as RequestInit).body as ArrayBuffer).byteLength).toBe(8);
  });
});
