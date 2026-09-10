import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAppDeployDeclaration,
  resolveLayers,
  defaultLayersForKind,
  layerArn,
} from "../../src/lib/provisioning/app-runtime-spec.js";

test("parse: accepts build+start for node", () => {
  const d = parseAppDeployDeclaration({
    build: { kind: "node", output: ".output" },
    start: {
      fcRuntime: "custom.debian10",
      command: ["/opt/nodejs20/bin/node"],
      args: ["server/index.mjs"],
      port: 9000,
    },
  });
  assert.equal(d.build.kind, "node");
  assert.deepEqual(d.start.command, ["/opt/nodejs20/bin/node"]);
  assert.equal(d.start.layers, undefined);
});

test("parse: refuses legacy runtime/entry shape", () => {
  assert.throws(
    () =>
      parseAppDeployDeclaration({
        runtime: "node",
        entry: "server/index.mjs",
        port: 9000,
      }),
    (e: any) => /legacy|runtime\.entry|teamclu\.app\.json/i.test(String(e?.message ?? e)),
  );
});

test("parse: container may omit command; forces no required fcRuntime", () => {
  const d = parseAppDeployDeclaration({
    build: { kind: "container", dockerfile: "Dockerfile", context: "." },
    start: { port: 5000, healthCheckPath: "/api/health" },
  });
  assert.equal(d.build.kind, "container");
  assert.equal(d.start.port, 5000);
});

test("parse: non-container requires non-empty command array", () => {
  assert.throws(() =>
    parseAppDeployDeclaration({
      build: { kind: "python", output: "." },
      start: { fcRuntime: "custom.debian10", command: [], args: ["app.py"], port: 9000 },
    }),
  );
});

test("parse: healthCheckPath must start with /", () => {
  assert.throws(() =>
    parseAppDeployDeclaration({
      build: { kind: "container" },
      start: { port: 9000, healthCheckPath: "health" },
    }),
  );
});

test("resolveLayers: omitted uses defaults; [] uses none", () => {
  const region = "cn-shenzhen";
  assert.ok(defaultLayersForKind(region, "node").length >= 1);
  assert.deepEqual(resolveLayers(region, "node", undefined), defaultLayersForKind(region, "node"));
  assert.deepEqual(resolveLayers(region, "node", []), []);
  assert.deepEqual(
    resolveLayers(region, "node", [layerArn(region, "Python310", 1)]),
    [layerArn(region, "Python310", 1)],
  );
});
