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


describe("apps module · auth-info", () => {
 it("returns the full catalog/config response using encoded app ID", async () => {
  const info = {appId:"app 1", teamId:"team", organization:{id:"org",name:"Org"},roleScope:"organization",roles:[{id:"r",code:"reviewer",name:"Reviewer",status:"active"}],authMode:"platform",authScope:"paths",authAudience:"org",authRules:[{path:"/staff",auth:"required",audience:"org"}],effectivePolicies:[],organizationStatus:"configured"};
  const client = {get:vi.fn(async()=>info)} as unknown as CloudApiClient;
  expect(await createAppsModule(client).getAppAuthInfo("app 1")).toEqual(info);
  expect(client.get).toHaveBeenCalledWith("/v1/apps/app%201/auth-info");
 });
 for (const status of [403,404,503]) it(`propagates ${status}`,async()=>{
  const error = new CloudApiError(status,"unavailable","failed",null);
  const client={get:vi.fn(async()=>{throw error;})} as unknown as CloudApiClient;
  await expect(createAppsModule(client).getAppAuthInfo("app")).rejects.toBe(error);
 });
});
