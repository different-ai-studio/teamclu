import { parseAppRuntimeSpec } from "../src/lib/provisioning/app-deploy.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

function deps() {
  return {
    createRepository: ({ accessToken }: { accessToken: string }) => ({
      listTeams: async () => [{ id: "t1", name: "Team", accessToken }],
    }),
    createAuthRepository: () => ({}),
  };
}

test("GET /v1/teams routes through adapter with bearer", async () => {
  const app = createApp(deps() as any);
  const res = await app.request("/v1/teams", { headers: { authorization: "Bearer abc" } });
  assert.notEqual(res.status, 404);
  assert.notEqual(res.status, 401);
});

test("unknown route -> 404 not_found envelope", async () => {
  const app = createApp(deps() as any);
  const res = await app.request("/v1/nope-nope", { headers: { authorization: "Bearer abc" } });
  assert.equal(res.status, 404);
  assert.equal((await res.json() as any).error.code, "not_found");
});

test("missing bearer on /v1/teams -> 401", async () => {
  const app = createApp(deps() as any);
  const res = await app.request("/v1/teams");
  assert.equal(res.status, 401);
});

test("parseAppRuntimeSpec: absent keeps the contract every app had before", () => {
  assert.equal(parseAppRuntimeSpec(undefined), undefined);
  assert.equal(parseAppRuntimeSpec(null), undefined);
});

test("parseAppRuntimeSpec: a declared start is taken as declared", () => {
  assert.deepEqual(parseAppRuntimeSpec({ runtime: "node", entry: "index.js", port: 8080 }), {
    runtime: "node",
    entry: "index.js",
    port: 8080,
  });
});

test("parseAppRuntimeSpec: refuses what would produce a function that cannot boot", () => {
  // The runtime image ships no interpreter; a binary reaches the instance only
  // if a matching layer was attached, so an unknown runtime is a 400 here
  // rather than an opaque instance failure minutes later.
  assert.throws(
    () => parseAppRuntimeSpec({ runtime: "python", entry: "app.py", port: 9000 }),
    /not available on this deployment/,
  );
  // The entry is joined against the unpacked artifact by the runtime, not by us.
  assert.throws(
    () => parseAppRuntimeSpec({ runtime: "node", entry: "/etc/passwd", port: 9000 }),
    /inside the artifact/,
  );
  assert.throws(
    () => parseAppRuntimeSpec({ runtime: "node", entry: "../x.js", port: 9000 }),
    /inside the artifact/,
  );
  assert.throws(
    () => parseAppRuntimeSpec({ runtime: "node", entry: "index.js", port: 0 }),
    /TCP port/,
  );
});
