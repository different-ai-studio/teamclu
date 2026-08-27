import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { provisionTwoNodeTeam } from "../harness/setup.mjs";
import { writeFile, readFile, contentRootPath } from "../harness/docker.mjs";
import { sync, conflicts } from "../harness/daemon-client.mjs";
import { isSidecar } from "../harness/converge.mjs";

// Verifies the fix for the concurrent-edit data-loss bug: when a node has an
// UNSYNCED local edit and a newer remote version arrives, the pull must preserve
// the local edit as a conflict sidecar (not silently overwrite it). The engine
// now scans the working tree BEFORE the pull loop so it sees current dirtiness.

// Generous settle so A's new version is reliably visible in the (eventually
// consistent) manifest before B's competing sync — otherwise B pushes first and
// no conflict is produced. Prod FC manifest propagation is usually seconds.
const settle = (ms = 20000) => new Promise((r) => setTimeout(r, ms));

let ctx;
before(async () => { ctx = await provisionTwoNodeTeam(); }, { timeout: 180000 });
after(async () => { await ctx?.teardown(); }, { timeout: 120000 });

test("concurrent edit: B's unsynced edit is preserved as a conflict sidecar (remote wins the file)", { timeout: 150000 }, async () => {
  const { nodes, teamId } = ctx;
  const root = contentRootPath(teamId);

  // Base: A creates knowledge/x.md, both sync to it (B's state: synced, dirty=false).
  await writeFile("node-a", `${root}/knowledge/x.md`, Buffer.from("base\n"));
  await sync(nodes.a);
  await settle();
  await sync(nodes.b);

  // A edits + syncs FIRST → remote advances to A-edit.
  await writeFile("node-a", `${root}/knowledge/x.md`, Buffer.from("A-edit\n"));
  const a1 = await sync(nodes.a);
  assert.equal(a1.lastError ?? null, null, `A sync error: ${a1.lastError}`);
  assert.ok(a1.pushed >= 1, `A should push, got ${a1.pushed}`);

  // B edits the SAME file but has NOT synced since (state still dirty=false),
  // then syncs once after A's version is visible in the manifest.
  await settle();
  await writeFile("node-b", `${root}/knowledge/x.md`, Buffer.from("B-edit\n"));
  const b1 = await sync(nodes.b);
  assert.equal(b1.lastError ?? null, null, `B sync error: ${b1.lastError}`);

  // FIXED behavior: a conflict is reported, B's local file holds remote (A-edit),
  // and B's edit (B-edit) is preserved in a sidecar — NOT lost.
  assert.ok(b1.conflicts >= 1, `B should report a conflict, got ${b1.conflicts}`);

  const treeB = await ctx.lsContentRoot("node-b", teamId);
  const bContent = treeB["knowledge/x.md"] && Buffer.from(treeB["knowledge/x.md"], "base64").toString();
  assert.equal(bContent, "A-edit\n", `B's x.md should hold remote (A-edit), got ${JSON.stringify(bContent)}`);

  // Conflicts API: `path` is the original document; `sidecar` is the .conflicts/ copy.
  const cs = await conflicts(nodes.b);
  const sidecars = cs.filter((c) => c.kind === "oss-sidecar" && isSidecar(c.sidecar));
  assert.ok(sidecars.length >= 1, `expected a sidecar preserving B's edit, got ${JSON.stringify(cs)}`);

  // The sidecar must contain B's lost edit.
  const sidecarRel = sidecars[0].sidecar;
  const sidecarBuf = await readFile("node-b", `${root}/${sidecarRel}`);
  assert.ok(sidecarBuf, `sidecar file ${sidecarRel} should be readable`);
  assert.equal(sidecarBuf.toString(), "B-edit\n", "sidecar must preserve B's original edit (no data loss)");
});
