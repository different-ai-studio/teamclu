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

describe('apps module · undeploy',()=>{
 it('returns accepted operation without declaring completion',async()=>{
  const result={app:{id:'a',fcStatus:'uninstalling'},operation:{id:'op',status:'pending'}};
  const client={post:vi.fn(async()=>result)} as unknown as CloudApiClient;
  expect(await createAppsModule(client).undeployApp('app 1')).toEqual(result);
  expect(client.post).toHaveBeenCalledWith('/v1/apps/app%201/undeploy',{});
 });
});

describe("apps module · listApps", () => {
  it("follows nextCursor to the last page", async () => {
    const get = vi.fn(async (path: string) => {
      const cursor = new URL(path, "http://x").searchParams.get("cursor");
      if (!cursor) return { items: [{ id: "a1" }, { id: "a2" }], nextCursor: "c1" };
      if (cursor === "c1") return { items: [{ id: "a3" }], nextCursor: null };
      throw new Error(`unexpected cursor ${cursor}`);
    });
    const out = await createAppsModule({ get } as unknown as CloudApiClient).listApps("team 1");
    expect(out.map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[0][0]).toBe("/v1/apps?teamId=team+1&limit=100");
    expect(get.mock.calls[1][0]).toBe("/v1/apps?teamId=team+1&limit=100&cursor=c1");
  });

  it("stops after one page on a server that does not page", async () => {
    const get = vi.fn(async () => ({ items: [{ id: "a1" }] }));
    const out = await createAppsModule({ get } as unknown as CloudApiClient).listApps("team-1");
    expect(out.map((a) => a.id)).toEqual(["a1"]);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
