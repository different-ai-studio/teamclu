import { parseAppDeployDeclaration } from "../src/lib/provisioning/app-deploy.js";
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

test("parseAppDeployDeclaration: a declaration is required", () => {
  assert.throws(() => parseAppDeployDeclaration(undefined), /must be an object/);
  assert.throws(() => parseAppDeployDeclaration(null), /must be an object/);
});

test("parseAppDeployDeclaration: build and start are taken as declared", () => {
  assert.deepEqual(parseAppDeployDeclaration({
    build: { kind: "python", output: "." },
    start: { fcRuntime: "custom.debian12", command: ["python3"], args: ["app.py"], port: 8080 },
  }), {
    build: { kind: "python", output: ".", command: undefined },
    start: { fcRuntime: "custom.debian12", command: ["python3"], args: ["app.py"], port: 8080 },
  });
});

test("parseAppDeployDeclaration: refuses the legacy runtime and entry shape", () => {
  assert.throws(
    () => parseAppDeployDeclaration({ runtime: "node", entry: "server/index.mjs", port: 9000 }),
    /legacy runtime\/entry shape/,
  );
});

test("parseAppDeployDeclaration: refuses invalid start configuration", () => {
  assert.throws(
    () => parseAppDeployDeclaration({
      build: { kind: "node" },
      start: { fcRuntime: "custom.debian10", command: ["/opt/nodejs20/bin/node"], args: ["index.js"], port: 0 },
    }),
    /TCP port/,
  );
});
