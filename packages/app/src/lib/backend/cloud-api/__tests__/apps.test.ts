import { describe, expect, it, vi } from "vitest";
import { createAppsModule } from "@/lib/backend/cloud-api/apps";
import { CloudApiError, type CloudApiClient } from "@/lib/backend/cloud-api/http";

function clientWithPatch(patch: (path: string, body: unknown) => Promise<unknown>): CloudApiClient {
  return { patch: vi.fn(patch) } as unknown as CloudApiClient;
}

describe("apps module · setAppType", () => {
  it("PATCHes only the type onto the app", async () => {
    const row = { id: "app 1", type: "slides", typePendingRedeploy: true };
    const client = clientWithPatch(async () => row);
    const out = await createAppsModule(client).setAppType("app 1", "slides");

    expect(client.patch).toHaveBeenCalledWith("/v1/apps/app%201", { type: "slides" });
    expect(out).toBe(row);
  });

  it("reads a 404 as not permitted rather than throwing", async () => {
    // A caller without admin and a missing app get the same 404; the store
    // turns null into a sentence, a throw would surface the raw message.
    const client = clientWithPatch(async () => {
      throw new CloudApiError(404, "not_found", "app not found", null);
    });
    await expect(createAppsModule(client).setAppType("app-1", "data_app")).resolves.toBeNull();
  });

  it("lets every other failure through", async () => {
    const client = clientWithPatch(async () => {
      throw new CloudApiError(400, "invalid_type", "type must be one of …", null);
    });
    await expect(createAppsModule(client).setAppType("app-1", "static_web")).rejects.toThrow(
      "type must be one of",
    );
  });
});
