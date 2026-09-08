import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

/**
 * The vanity middleware used to read `Host` and nothing else. On Alibaba
 * Function Compute the request is rebuilt from the trigger event by
 * hono/aws-lambda, and the app's own hostname reached the handler on the URL
 * rather than as a Host header — so every `*.<APPS_PUBLIC_DOMAIN>` URL fell
 * through to the API router and answered "Route not found" instead of the app.
 */
const APP = {
  id: "402c71eb-de8e-410b-8d8e-981953ce306f",
  slug: "todo-list",
  fcEndpoint: "http://todo-list-402c71eb.fc-apps.mx5.cn",
  fcStatus: "live",
};

function appWithLookup(seen: string[]) {
  return createApp({
    createRepository: () => ({}) as any,
    createAuthRepository: () => ({}) as any,
    lookupVanityApp: async (host: string) => {
      seen.push(host);
      return host.startsWith("todo-list-402c71eb.") ? APP : null;
    },
  } as any);
}

const withDomain = async (fn: () => Promise<void>) => {
  const prev = process.env.APPS_PUBLIC_DOMAIN;
  process.env.APPS_PUBLIC_DOMAIN = "apps.mx5.cn";
  try { await fn(); } finally {
    if (prev === undefined) delete process.env.APPS_PUBLIC_DOMAIN;
    else process.env.APPS_PUBLIC_DOMAIN = prev;
  }
};

test("resolves the app host from the Host header", async () => {
  await withDomain(async () => {
    const seen: string[] = [];
    const res = await appWithLookup(seen).request("http://placeholder/", {
      headers: { host: "todo-list-402c71eb.apps.mx5.cn" },
    });
    assert.deepEqual(seen, ["todo-list-402c71eb.apps.mx5.cn"]);
    assert.notEqual(res.status, 404, "must not fall through to the API router");
  });
});

test("resolves it from the request URL when no Host header survives (the FC shape)", async () => {
  await withDomain(async () => {
    const seen: string[] = [];
    // hono/aws-lambda composes the URL from requestContext.domainName; the Host
    // header is not what carries the name on that path.
    const res = await appWithLookup(seen).request("https://todo-list-402c71eb.apps.mx5.cn/");
    assert.deepEqual(seen, ["todo-list-402c71eb.apps.mx5.cn"]);
    assert.notEqual(res.status, 404);
  });
});

test("x-forwarded-host wins over a proxy-rewritten Host", async () => {
  await withDomain(async () => {
    const seen: string[] = [];
    await appWithLookup(seen).request("http://placeholder/", {
      headers: {
        host: "internal-proxy.example",
        "x-forwarded-host": "todo-list-402c71eb.apps.mx5.cn, other.example",
      },
    });
    assert.deepEqual(seen, ["todo-list-402c71eb.apps.mx5.cn"]);
  });
});

test("a non-app host still falls through to the API router", async () => {
  await withDomain(async () => {
    const seen: string[] = [];
    const res = await appWithLookup(seen).request("https://teamclaw-api.ucar.cc/definitely-not-a-route");
    assert.deepEqual(seen, [], "lookup must not be consulted for a non-app host");
    assert.equal(res.status, 404);
  });
});
