import assert from "node:assert/strict";
import test from "node:test";
import {
  RUNTIME_PROFILES,
  pathLookup,
  parseLayerRef,
  layerRootOf,
  startProgram,
} from "../../src/lib/provisioning/app-runtime-profiles.js";

test("profiles: node and python run the image's own interpreter with no layer", () => {
  assert.deepEqual(RUNTIME_PROFILES.node, {
    fcRuntime: "custom.debian10",
    interpreter: "/var/fc/lang/nodejs20/bin/node",
    argsFor: "entry",
    layers: [],
    entryRequired: true,
    verified: true,
  });
  assert.deepEqual(RUNTIME_PROFILES.python, {
    fcRuntime: "custom.debian10",
    interpreter: "/var/fc/lang/python3.10/bin/python3",
    argsFor: "entry",
    layers: [],
    entryRequired: true,
    verified: true,
  });
});

test("profiles: go runs its static binary and needs no entry", () => {
  assert.equal(RUNTIME_PROFILES.go.interpreter, "./main");
  assert.deepEqual(RUNTIME_PROFILES.go.layers, []);
  assert.equal(RUNTIME_PROFILES.go.entryRequired, false);
});

test("profiles: php and java are declared but not verified", () => {
  for (const kind of ["php", "java"] as const) {
    assert.equal(RUNTIME_PROFILES[kind].verified, false, kind);
    assert.ok(RUNTIME_PROFILES[kind].layers.length > 0, kind);
  }
  assert.deepEqual(RUNTIME_PROFILES.php.layers, ["PHP81-Debian10:1"]);
  assert.deepEqual(RUNTIME_PROFILES.java.layers, ["Java17:3"]);
});

test("pathLookup: node is absent from PATH on debian10, python3 is the wrong one", () => {
  assert.deepEqual(pathLookup("custom.debian10", "node"), { kind: "absent" });
  const py = pathLookup("custom.debian10", "python3");
  assert.equal(py.kind, "resolves");
  assert.equal(py.kind === "resolves" && py.path, "/usr/bin/python3");
});

test("pathLookup: Debian 9 interpreters are present but ancient", () => {
  const node = pathLookup("custom", "node");
  assert.equal(node.kind === "resolves" && node.version, "10.16.2");
  const py = pathLookup("custom", "python3");
  assert.equal(py.kind === "resolves" && py.version, "3.7.4");
});

test("pathLookup: an image or name we never probed is unknown, not absent", () => {
  assert.deepEqual(pathLookup("custom.debian12", "node"), { kind: "unknown" });
  assert.deepEqual(pathLookup("custom.debian10", "perl"), { kind: "unknown" });
});

test("parseLayerRef: ARNs and region-free shorthand", () => {
  assert.deepEqual(parseLayerRef("acs:fc:cn-shenzhen:official:layers/Nodejs20/versions/3"), {
    kind: "official",
    region: "cn-shenzhen",
    name: "Nodejs20",
    version: 3,
  });
  assert.deepEqual(parseLayerRef("Nodejs20:3"), {
    kind: "shorthand",
    name: "Nodejs20",
    version: 3,
  });
  assert.equal(parseLayerRef("Nodejs20"), null);
  assert.equal(parseLayerRef("not an arn"), null);
});

test("parseLayerRef: an account-owned layer keeps its owner", () => {
  const ref = parseLayerRef("acs:fc:cn-shenzhen:1234567890:layers/mine/versions/2");
  assert.equal(ref?.kind, "account");
  assert.equal(ref?.kind === "account" && ref.owner, "1234567890");
});

test("layerRootOf: only an /opt mount counts", () => {
  assert.equal(layerRootOf("/opt/nodejs20/bin/node"), "/opt/nodejs20");
  assert.equal(layerRootOf("/var/fc/lang/nodejs20/bin/node"), null);
  assert.equal(layerRootOf("node"), null);
});

test("startProgram: the program inside a shell one-liner is the one that runs", () => {
  // The shape the one live Python app uses. Stopping at command[0] reports bash.
  const p = startProgram(
    ["/bin/bash"],
    ["-c", "PYTHONPATH=/code/lib python3 -m uvicorn app.main:app --port 9000"],
  );
  assert.equal(p?.basename, "python3");
  assert.equal(p?.form, "bare");
  assert.equal(p?.viaShell, true);
});

test("startProgram: plain argv, and nothing at all", () => {
  const abs = startProgram(["/opt/nodejs20/bin/node"], ["server/index.mjs"]);
  assert.equal(abs?.form, "absolute");
  assert.equal(abs?.basename, "node");
  assert.equal(abs?.viaShell, false);
  assert.equal(startProgram([], []), null);
  assert.equal(startProgram(undefined, undefined), null);
});
