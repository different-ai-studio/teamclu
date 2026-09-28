import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAppDeployDeclaration,
  resolveLayers,
  layerArn,
  checkStartEnvironment,
} from "../../src/lib/provisioning/app-runtime-spec.js";

test("parse: accepts build+start for node", () => {
  const d = parseAppDeployDeclaration({
    build: { kind: "node", output: ".output" },
    start: {
      fcRuntime: "custom.debian10",
      command: ["/var/fc/lang/nodejs20/bin/node"],
      args: ["server/index.mjs"],
      port: 9000,
      layers: [],
    },
  });
  assert.equal(d.build.kind, "node");
  assert.deepEqual(d.start.command, ["/var/fc/lang/nodejs20/bin/node"]);
  assert.deepEqual(d.start.layers, []);
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
        command: ["./run"],
        args: [],
        port: 9000,
        layers: [],
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
      start: { fcRuntime: "custom.debian10", command: [], args: ["app.py"], port: 9000, layers: [] },
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

test("resolveLayers: [] attaches no layer", () => {
  const region = "cn-shenzhen";
  assert.deepEqual(resolveLayers(region, "node", []), []);
  assert.deepEqual(
    resolveLayers(region, "node", [layerArn(region, "Python310", 1)]),
    [layerArn(region, "Python310", 1)],
  );
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

// ---------------------------------------------------------------------------
// Explicit starts: the platform must not choose a runtime or version.
// ---------------------------------------------------------------------------

test("parse: start.entry is rejected even alongside explicit fields", () => {
  for (const start of [
    { entry: "server/index.mjs", port: 9000 },
    { entry: "", fcRuntime: "custom.debian10", command: ["/bin/bash"], port: 9000 },
    { entry: "server/index.mjs", fcRuntime: "custom.debian10", command: ["/bin/bash"], port: 9000 },
  ]) {
    assert.throws(
      () => parseAppDeployDeclaration({ build: { kind: "node" }, start }),
      (e: any) => /start\.entry/.test(String(e?.message ?? e)) && /fcRuntime/.test(String(e?.message ?? e)) && /runtime_info/.test(String(e?.message ?? e)),
    );
  }
});

test("parse: explicit starts survive for Node, Go, Python and Java", () => {
  for (const [kind, command, args] of [
    ["node", ["/var/fc/lang/nodejs20/bin/node"], ["server/index.mjs"]],
    ["go", ["./main"], []],
    ["python", ["/bin/bash"], ["-c", "python3 -m uvicorn app.main:app"]],
    ["java", ["./run-java"], []],
  ] as const) {
    const declaration = parseAppDeployDeclaration({
      build: { kind },
      start: { fcRuntime: "custom.debian10", command, args, port: 9000, layers: [] },
    });
    assert.deepEqual(declaration.start, { fcRuntime: "custom.debian10", command, args, port: 9000, layers: [] }, kind);
  }
});

test("parse: non-container startup requires an explicit runtime and command", () => {
  for (const start of [{ port: 9000 }, { command: ["./main"], port: 9000 }]) {
    assert.throws(
      () => parseAppDeployDeclaration({ build: { kind: "go" }, start }),
      (e: any) => /start\.fcRuntime/.test(String(e?.message ?? e)),
    );
  }
});

test("parse: non-container startup requires explicit layers without choosing a version", () => {
  assert.throws(
    () => parseAppDeployDeclaration({
      build: { kind: "node" },
      start: { fcRuntime: "custom.debian10", command: ["/var/fc/lang/nodejs20/bin/node"], args: ["server/index.mjs"], port: 9000 },
    }),
    (e: any) => /start\.layers/.test(String(e?.message ?? e)) && /runtime_info/.test(String(e?.message ?? e)),
  );
});

test("parse: non-container startup requires an explicit port", () => {
  assert.throws(
    () => parseAppDeployDeclaration({
      build: { kind: "go" },
      start: { fcRuntime: "custom.debian10", command: ["./main"], args: [], layers: [] },
    }),
    (e: any) => /start\.port/.test(String(e?.message ?? e)) && /required/.test(String(e?.message ?? e)),
  );
});

test("regression: every live app's passthrough spec still parses to itself", () => {
  // Read off the live apps in cn-shenzhen on 2026-09-23. These must keep
  // deploying byte-identically; the profile table applies only to the short form.
  const live = [
    {
      build: { kind: "node", output: ".output" },
      start: {
        fcRuntime: "custom.debian10",
        command: ["/opt/nodejs20/bin/node"],
        args: ["server/index.mjs"],
        port: 9000,
        layers: ["acs:fc:cn-shenzhen:official:layers/Nodejs20/versions/2"],
      },
    },
    {
      build: { kind: "python", output: "." },
      start: {
        fcRuntime: "custom",
        command: ["/bin/bash"],
        args: [
          "-c",
          "PYTHONPATH=/code/lib python3 -m uvicorn app.main:app --host 0.0.0.0 --port 9000 --loop asyncio",
        ],
        port: 9000,
        layers: [],
      },
    },
  ];
  for (const decl of live) {
    const d = parseAppDeployDeclaration(decl);
    assert.equal(d.start.fcRuntime, decl.start.fcRuntime);
    assert.deepEqual(d.start.command, decl.start.command);
    assert.deepEqual(d.start.args, decl.start.args);
    assert.deepEqual(d.start.layers, decl.start.layers);
  }
});

// ---------------------------------------------------------------------------
// Preflight on the passthrough form: refuse what the image cannot run.
// ---------------------------------------------------------------------------

test("preflight: /opt path with no layer to mount it is refused", () => {
  // Deployed clean and then failed to boot with "/opt/nodejs20/bin/node is not exist".
  assert.throws(
    () =>
      parseAppDeployDeclaration({
        build: { kind: "node", output: ".output" },
        start: {
          fcRuntime: "custom.debian10",
          command: ["/opt/nodejs20/bin/node"],
          args: ["server/index.mjs"],
          port: 9000,
          layers: [],
        },
      }),
    (e: any) => {
      const m = String(e?.message ?? e);
      return m.includes("/opt/nodejs20") && m.includes("Nodejs20");
    },
  );
});

test("preflight: a bare interpreter absent from the image is refused", () => {
  assert.throws(
    () =>
      parseAppDeployDeclaration({
        build: { kind: "node" },
        start: {
          fcRuntime: "custom.debian10",
          command: ["node"],
          args: ["server/index.mjs"],
          port: 9000,
          layers: [],
        },
      }),
    (e: any) => {
      const m = String(e?.message ?? e);
      return /not on PATH/.test(m) && m.includes("/var/fc/lang/nodejs20/bin/node");
    },
  );
});

test("preflight: Debian 9 interpreters warn by version, inside a shell too", () => {
  // Stale, not absent. james-test1 serves traffic on 3.7.4 today, so refusing
  // would block a working app; the trap is named instead of enforced.
  const warnings = checkStartEnvironment(
    { kind: "python", output: "." },
    {
      fcRuntime: "custom",
      command: ["/bin/bash"],
      args: ["-c", "PYTHONPATH=/code/lib python3 -m uvicorn app.main:app"],
      port: 9000,
      layers: [],
    },
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /3\.7\.4/);
  assert.match(warnings[0], /start\.args/);
  assert.match(warnings[0], /custom\.debian10/);
});

test("preflight: an unverified layer makes the /opt rule step aside", () => {
  // Go1's mount path is unknown, so we cannot prove /opt/go is missing.
  const d = parseAppDeployDeclaration({
    build: { kind: "go", output: "." },
    start: {
      fcRuntime: "custom.debian10",
      command: ["/opt/go/bin/app"],
      args: [],
      port: 9000,
      layers: ["Go1:1"],
    },
  });
  assert.deepEqual(d.start.layers, ["Go1:1"]);
});

test("preflight: bare python3 on debian10 warns about the silent downgrade", () => {
  const warnings = checkStartEnvironment(
    { kind: "python", output: "." },
    {
      fcRuntime: "custom.debian10",
      command: ["python3"],
      args: ["app.py"],
      port: 9000,
      layers: [],
    },
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\/usr\/bin\/python3/);
  assert.match(warnings[0], /\/var\/fc\/lang\/python3\.10\/bin\/python3/);
});

test("preflight: container apps are not second-guessed", () => {
  assert.deepEqual(
    checkStartEnvironment(
      { kind: "container", output: ".", dockerfile: "Dockerfile", context: "." },
      { port: 8080 },
    ),
    [],
  );
});

// The daemon serialization test asserts this same wire payload, so null fields
// cannot quietly reappear between checkout parsing and deploy finalization.
test("parse: accepts the daemon's serialized explicit declaration", () => {
  const wire = JSON.parse(readFileSync(new URL("../fixtures/daemon-explicit-declaration.json", import.meta.url), "utf8"));
  const declaration = parseAppDeployDeclaration(wire);
  assert.equal(declaration.start.fcRuntime, "custom.debian10");
  assert.deepEqual(declaration.start.command, ["/var/fc/lang/nodejs20/bin/node"]);
  assert.deepEqual(declaration.start.args, ["server/index.mjs"]);
  assert.equal(declaration.start.port, 9000);
  assert.deepEqual(declaration.start.layers, []);
});
