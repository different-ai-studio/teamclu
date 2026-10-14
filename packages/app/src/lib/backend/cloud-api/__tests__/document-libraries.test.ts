import { describe, expect, it, vi } from "vitest";
import { createDocumentLibrariesModule } from "@/lib/backend/cloud-api/document-libraries";
import type { CloudApiClient } from "@/lib/backend/cloud-api/http";

function mockClient(handlers: {
  get?: (path: string) => Promise<unknown>;
  post?: (path: string, body?: unknown) => Promise<unknown>;
  put?: (path: string, body?: unknown) => Promise<unknown>;
  delete?: (path: string) => Promise<unknown>;
}): CloudApiClient {
  return {
    get: vi.fn(handlers.get ?? (async () => { throw new Error("unexpected GET"); })),
    post: vi.fn(handlers.post ?? (async () => { throw new Error("unexpected POST"); })),
    patch: vi.fn(async () => { throw new Error("unexpected PATCH"); }),
    put: vi.fn(handlers.put ?? (async () => { throw new Error("unexpected PUT"); })),
    delete: vi.fn(handlers.delete ?? (async () => { throw new Error("unexpected DELETE"); })),
    postRaw: vi.fn(async () => { throw new Error("not impl"); }),
    getRaw: vi.fn(async () => { throw new Error("not impl"); }),
  } as unknown as CloudApiClient;
}

describe("document-libraries module", () => {
  it("calls the document-library role API paths", async () => {
    const get = vi.fn(async () => ({ items: [] }));
    const post = vi.fn(async () => ({
      id: "acl-1",
      pathPrefix: "documents/财务/",
      audience: "roles" as const,
      roles: [],
      actorIds: [],
    }));
    const put = vi.fn(async () => ({
      id: "acl-1",
      pathPrefix: "documents/财务/",
      audience: "roles" as const,
      roles: [],
      actorIds: [],
    }));
    const del = vi.fn(async () => undefined);
    const client = mockClient({ get, post, put, delete: del });
    const api = createDocumentLibrariesModule(client);

    await api.listDocumentLibraries("team-1");
    expect(get).toHaveBeenCalledWith("/v1/teams/team-1/document-libraries");

    await api.previewDocumentLibrary("team-1", {
      pathPrefix: "documents/财务/",
      roleIds: ["fin"],
    });
    expect(post).toHaveBeenCalledWith("/v1/teams/team-1/document-libraries/preview", {
      pathPrefix: "documents/财务/",
      roleIds: ["fin"],
    });

    await api.createDocumentLibrary("team-1", {
      pathPrefix: "documents/财务/",
      roleIds: ["fin"],
      confirmRevokeExisting: true,
    });
    expect(post).toHaveBeenCalledWith("/v1/teams/team-1/document-libraries", {
      pathPrefix: "documents/财务/",
      roleIds: ["fin"],
      confirmRevokeExisting: true,
    });

    await api.putDocumentLibrary("team-1", "acl-1", { roleIds: ["fin"] });
    expect(put).toHaveBeenCalledWith("/v1/teams/team-1/document-libraries/acl-1", {
      roleIds: ["fin"],
    });

    await api.deleteDocumentLibrary("team-1", "acl-1");
    expect(del).toHaveBeenCalledWith("/v1/teams/team-1/document-libraries/acl-1");
  });

  it("list returns [] when items is missing", async () => {
    const client = mockClient({ get: async () => ({}) });
    const out = await createDocumentLibrariesModule(client).listDocumentLibraries("team-1");
    expect(out).toEqual([]);
  });
});
