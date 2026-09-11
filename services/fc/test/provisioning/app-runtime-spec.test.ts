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

test("parse: build output defaults match the daemon build table", () => {
  for (const [kind, output] of [
    ["node", ".output"],
    ["python", "."],
    ["go", "."],
    ["php", "."],
    ["java", "."],
  ] as const) {
    const d = parseAppDeployDeclaration({
      build: { kind },
      start: {
        fcRuntime: "custom.debian10",
        command: ["run"],
        port: 9000,
      },
    });
    assert.equal(d.build.output, output, kind);
  }
});

test("parse: refuses legacy runtime/entry shape", () => {
  for (const legacy of [{ runtime: null }, { entry: { path: "server/index.mjs" } }]) {
    assert.throws(
      () =>
        parseAppDeployDeclaration({
          ...legacy,
          build: { kind: "node" },
          start: {
            fcRuntime: "custom.debian10",
            command: ["node"],
            port: 9000,
          },
        }),
      (e: any) => /legacy|runtime\.entry|teamclu\.app\.json/i.test(String(e?.message ?? e)),
    );
  }
});

test("parse: omitted container command and args stay undefined", () => {
  const d = parseAppDeployDeclaration({
    build: { kind: "container", dockerfile: "Dockerfile", context: "." },
    start: { port: 5000, healthCheckPath: "/api/health" },
  });
  assert.equal(d.build.kind, "container");
  assert.equal(d.start.port, 5000);
  assert.equal(d.start.command, undefined);
  assert.equal(d.start.args, undefined);
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
  assert.deepEqual(defaultLayersForKind(region, "java"), [
    layerArn(region, "Java17", 3),
  ]);
});
