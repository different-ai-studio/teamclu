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

// ---------------------------------------------------------------------------
// Layer references: the region is the platform's to know, not the author's.
// ---------------------------------------------------------------------------

test("layers: an ARN from another region is refused here, naming the deploy region", () => {
  assert.throws(
    () => resolveLayers("cn-shenzhen", "node", [layerArn("cn-hangzhou", "Nodejs20", 3)]),
    (e: any) => {
      const m = String(e?.message ?? e);
      return /cn-hangzhou/.test(m) && /cn-shenzhen/.test(m) && /Nodejs20:3/.test(m);
    },
  );
});

test("layers: shorthand fills in the region so the author never writes one", () => {
  assert.deepEqual(resolveLayers("cn-shenzhen", "node", ["Nodejs20:3"]), [
    layerArn("cn-shenzhen", "Nodejs20", 3),
  ]);
  // The same file deploys to a different region without being edited.
  assert.deepEqual(resolveLayers("cn-beijing", "node", ["Nodejs20:3"]), [
    layerArn("cn-beijing", "Nodejs20", 3),
  ]);
});

test("layers: a matching-region ARN passes through untouched", () => {
  const arn = layerArn("cn-shenzhen", "Python310", 1);
  assert.deepEqual(resolveLayers("cn-shenzhen", "node", [arn]), [arn]);
});

test("layers: garbage is refused with a message naming both accepted forms", () => {
  assert.throws(
    () => resolveLayers("cn-shenzhen", "node", ["Nodejs20"]),
    (e: any) => /Name:version/.test(String(e?.message ?? e)),
  );
});
