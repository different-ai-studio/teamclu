import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { provisionTwoNodeTeam } from "../harness/setup.mjs";
import { writeFile, contentRootPath } from "../harness/docker.mjs";
import { sync } from "../harness/daemon-client.mjs";
import { assertConverged } from "../harness/converge.mjs";

// ADR-0008: knowledge uploads are plaintext. A team secret is no longer a
// sync precondition — nodes with no secret must still converge.

let ctx;
before(async () => {
  ctx = await provisionTwoNodeTeam({ withSecret: false });
  assert.equal(ctx.secret, null, "provision must not plant a team secret");
}, { timeout: 180000 });
after(async () => { await ctx?.teardown(); }, { timeout: 120000 });

test("no team secret: A writes knowledge/x.md -> B pulls identical", { timeout: 120000 }, async () => {
  const { nodes, teamId } = ctx;
  const root = contentRootPath(teamId);

  await writeFile("node-a", `${root}/knowledge/x.md`, Buffer.from("plaintext no secret\n"));
  const a1 = await sync(nodes.a);
  assert.equal(a1.lastError ?? null, null, `A sync error: ${a1.lastError}`);
  assert.equal(a1.mode, "oss");
  assert.ok(a1.pushed >= 1, `expected pushed>=1, got ${a1.pushed}`);

  const b1 = await sync(nodes.b);
  assert.equal(b1.lastError ?? null, null, `B sync error: ${b1.lastError}`);
  assert.ok(b1.pulled >= 1, `expected B pulled>=1, got ${b1.pulled}`);

  const treeA = await ctx.lsContentRoot("node-a", teamId);
  const treeB = await ctx.lsContentRoot("node-b", teamId);
  assert.ok(treeB["knowledge/x.md"], "B should have knowledge/x.md without a team secret");
  assert.equal(
    Buffer.from(treeB["knowledge/x.md"], "base64").toString(),
    "plaintext no secret\n",
  );
  assertConverged(treeA, treeB, "no-secret");
});
