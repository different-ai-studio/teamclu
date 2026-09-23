"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createCheckpoint,
  restoreCheckpoint,
} = require("./checkpoint");
const {
  ensureWikiRepo,
  commitAll,
  headCommit,
} = require("./git-store");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-checkpoint-"));
  const workRoot = path.join(root, "work");
  const wikiRoot = path.join(workRoot, "wiki");
  const statePath = path.join(workRoot, "state", "state.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    path.join(workRoot, "config.json"),
    `${JSON.stringify({ schemaVersion: 1, teamId: "11111111-1111-1111-1111-111111111111", sources: [] })}\n`,
  );
  ensureWikiRepo(wikiRoot);
  fs.writeFileSync(path.join(wikiRoot, "pages", "leave.md"), "# Leave\n");
  const head = commitAll(wikiRoot, "ingest(add): documents/leave.md@abcdef123456");
  fs.writeFileSync(
    statePath,
    `${JSON.stringify({
      schemaVersion: 1,
      teamId: "11111111-1111-1111-1111-111111111111",
      publishedCommit: null,
      sources: {},
    })}\n`,
  );
  return { root, workRoot, wikiRoot, statePath, head };
}

test("checkpoint round-trips state, prepared run, and the wiki git head", () => {
  const fx = fixture();
  const out = createCheckpoint({
    workRoot: fx.workRoot,
    teamId: "11111111-1111-1111-1111-111111111111",
    generation: 4,
    parentGeneration: 3,
    configVersion: 2,
    nodeId: "node-a",
    compilerModel: "team/default",
    preparedRun: {
      runId: "run-1",
      summary: { canPublish: true, added: 1, updated: 0, deleted: 0 },
    },
  });

  assert.equal(out.manifest.generation, 4);
  assert.equal(out.manifest.wikiHead, fx.head);
  assert.equal(out.manifest.readyToPublish, false);
  assert.equal(out.size, out.bytes.length);
  assert.equal(
    out.sha256,
    crypto.createHash("sha256").update(out.bytes).digest("hex"),
  );

  const restored = path.join(fx.root, "restored");
  restoreCheckpoint({
    workRoot: restored,
    bytes: out.bytes,
    publishedCommit: "f".repeat(40),
  });

  assert.equal(headCommit(path.join(restored, "wiki")), fx.head);
  assert.equal(
    fs.readFileSync(path.join(restored, "wiki", "pages", "leave.md"), "utf8"),
    "# Leave\n",
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(restored, "state", "state.json"), "utf8"))
      .teamId,
    "11111111-1111-1111-1111-111111111111",
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(restored, "state", "state.json"), "utf8"))
      .publishedCommit,
    "f".repeat(40),
  );
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(restored, "state", "prepared-run.json"), "utf8"),
    ).runId,
    "run-1",
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(restored, "config.json"), "utf8")).teamId,
    "11111111-1111-1111-1111-111111111111",
  );
});

test("restore rejects a package whose manifest does not match the git bundle", () => {
  const fx = fixture();
  const out = createCheckpoint({
    workRoot: fx.workRoot,
    teamId: "11111111-1111-1111-1111-111111111111",
    generation: 1,
    parentGeneration: 0,
    configVersion: 1,
    nodeId: "node-a",
    compilerModel: "team/default",
    preparedRun: {},
  });
  const tampered = Buffer.from(out.bytes);
  const marker = Buffer.from(fx.head);
  const at = tampered.indexOf(marker);
  assert.ok(at >= 0, "fixture checkpoint must contain the manifest head");
  Buffer.from("0".repeat(marker.length)).copy(tampered, at);

  assert.throws(
    () => restoreCheckpoint({ workRoot: path.join(fx.root, "bad"), bytes: tampered }),
    /checkpoint manifest hash mismatch|checkpoint wiki head mismatch/,
  );
});

test("restore rejects another team's checkpoint before replacing local files", () => {
  const fx = fixture();
  const out = createCheckpoint({
    workRoot: fx.workRoot,
    teamId: "11111111-1111-1111-1111-111111111111",
    generation: 1,
    parentGeneration: 0,
    configVersion: 1,
    nodeId: "node-a",
    compilerModel: "default",
    preparedRun: { runId: "run-1" },
    readyToPublish: false,
  });
  const restored = path.join(fx.root, "wrong-team-target");
  fs.mkdirSync(restored, { recursive: true });
  fs.writeFileSync(path.join(restored, "keep.txt"), "untouched");
  assert.throws(
    () =>
      restoreCheckpoint({
        workRoot: restored,
        bytes: out.bytes,
        expectedTeamId: "22222222-2222-2222-2222-222222222222",
      }),
    /another team/,
  );
  assert.equal(fs.readFileSync(path.join(restored, "keep.txt"), "utf8"), "untouched");
  assert.equal(fs.existsSync(path.join(restored, "wiki")), false);
});

test("checkpoint rejects credentials and local absolute paths", () => {
  const fx = fixture();
  fs.writeFileSync(
    path.join(fx.workRoot, "state", "state.json"),
    `${JSON.stringify({ schemaVersion: 1, note: "/Users/alice/secret" })}\n`,
  );
  assert.throws(
    () =>
      createCheckpoint({
        workRoot: fx.workRoot,
        teamId: "11111111-1111-1111-1111-111111111111",
        generation: 1,
        parentGeneration: 0,
        configVersion: 1,
        nodeId: "node-a",
        compilerModel: "default",
        preparedRun: {},
      }),
    /absolute path/,
  );
});

test("a newer checkpoint schema asks for a Desktop upgrade", () => {
  const fx = fixture();
  const out = createCheckpoint({
    workRoot: fx.workRoot,
    teamId: "11111111-1111-1111-1111-111111111111",
    generation: 1,
    parentGeneration: 0,
    configVersion: 1,
    nodeId: "node-a",
    compilerModel: "default",
    preparedRun: {},
  });
  const files = new Map(
    [...require("./zip").unzip(out.bytes).entries()].map(([name, data]) => [name, Buffer.from(data)]),
  );
  const manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
  manifest.schemaVersion = 2;
  files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
  const { zipStore } = require("./zip");
  const bytes = zipStore([...files.entries()].map(([name, data]) => ({ name, data })));
  assert.throws(
    () => restoreCheckpoint({ workRoot: path.join(fx.root, "newer"), bytes }),
    /Upgrade TeamClu/,
  );
});
