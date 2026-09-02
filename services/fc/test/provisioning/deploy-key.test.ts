import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import {
  actorJitDeployKeyIds,
  expiredJitDeployKeyIds,
  generateDeployKeyPair,
  issueJitDeployKey,
  jitDeployKeyTitle,
  parseOpenSshPrivateKey,
  parseOpenSshPublicKey,
  revokeActorDeployKeys,
  revokeOwnJitDeployKey,
  sweepExpiredDeployKeys,
  JIT_DEPLOY_KEY_TTL_MS,
} from "../../src/lib/provisioning/deploy-key.js";

test("generateDeployKeyPair returns an ed25519 OpenSSH public + OpenSSH private key", () => {
  const { publicKeyOpenSSH, privateKeyPem } = generateDeployKeyPair();
  assert.match(publicKeyOpenSSH, /^ssh-ed25519 /);
  // NOT `BEGIN PRIVATE KEY`: OpenSSH's PEM loader only accepts RSA/DSA/EC in a
  // PKCS#8 block and rejects an ed25519 one, so `ssh -i` failed on every push.
  assert.match(privateKeyPem, /^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
  assert.match(privateKeyPem, /-----END OPENSSH PRIVATE KEY-----\n$/);
  const parsed = parseOpenSshPublicKey(publicKeyOpenSSH);
  assert.equal(parsed.keyType, "ssh-ed25519");
  assert.equal(parsed.raw.length, 32);
});

test("the private key file really carries the advertised key", () => {
  const { publicKeyOpenSSH, privateKeyPem } = generateDeployKeyPair("deploy-key-test");
  const pub = parseOpenSshPublicKey(publicKeyOpenSSH);
  const priv = parseOpenSshPrivateKey(privateKeyPem);

  assert.equal(priv.keyType, "ssh-ed25519");
  assert.equal(priv.comment, "deploy-key-test");
  assert.ok(priv.publicKey.equals(pub.raw), "embedded public half matches");

  // Sign with the seed the file carries; verify with the registered public key.
  // If the two halves disagreed, git would authenticate against nothing.
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    priv.seed,
  ]);
  const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    pub.raw,
  ]);
  const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
  const message = Buffer.from("gitea deploy key round trip");
  assert.equal(verify(null, message, publicKey, sign(null, message, privateKey)), true);
});

test("JIT key titles embed actorId and are unique within the same millisecond", () => {
  const actorId = "actor-app-1";
  const now = 1_700_000_000_000;
  const a = jitDeployKeyTitle(actorId, now);
  const b = jitDeployKeyTitle(actorId, now);
  assert.notEqual(a, b, "two credentials minted in the same ms must not collide");
  assert.ok(a.startsWith(`jit-${actorId}-${now}-`));
});

test("expiredJitDeployKeyIds round-trips jitDeployKeyTitle mint time", () => {
  const actorId = "member-other";
  const now = 1_700_000_000_000;
  const title = jitDeployKeyTitle(actorId, now, "abcd1234");
  const keys = [{ id: 99, title }];
  assert.deepEqual(expiredJitDeployKeyIds(keys, now), []);
  assert.deepEqual(expiredJitDeployKeyIds(keys, now + JIT_DEPLOY_KEY_TTL_MS + 1), [99]);
});

test("expiredJitDeployKeyIds picks only our own keys, past the TTL", () => {
  const now = 1_700_000_000_000;
  const actorId = "actor-app-1";
  const keys = [
    { id: 1, title: `jit-${now - JIT_DEPLOY_KEY_TTL_MS - 1}-aaaa` }, // expired old format
    { id: 2, title: `jit-${now - 1000}-bbbb` }, // still valid old format
    { id: 3, title: "a-humans-own-key" }, // never ours to delete
    { id: 4, title: "jit-not-a-number" },
    { id: 5, title: `jit-${now - JIT_DEPLOY_KEY_TTL_MS - 1}` }, // legacy title
    { id: 6, title: `jit-${actorId}-${now - JIT_DEPLOY_KEY_TTL_MS - 1}-cccc` }, // expired new format
    { id: 7, title: `jit-${actorId}-${now - 1000}-dddd` }, // still valid new format
  ];
  assert.deepEqual(expiredJitDeployKeyIds(keys, now), [1, 5, 6]);
});

test("issuing a credential revokes the expired keys it left behind", async () => {
  const now = 1_700_000_000_000;
  const deleted: number[] = [];
  const gitea: any = {
    listDeployKeys: async () => [
      { id: 1, title: `jit-${now - JIT_DEPLOY_KEY_TTL_MS - 1}-aaaa` },
      { id: 2, title: `jit-${now - 1}-bbbb` },
    ],
    deleteDeployKey: async (_appId: string, id: number) => { deleted.push(id); },
    createDeployKey: async () => ({ id: 99 }),
  };
  const out = await issueJitDeployKey(gitea, "app-1", "actor-app-1", now);
  assert.deepEqual(deleted, [1], "only the expired one goes");
  assert.equal(out.deployKeyId, 99);
  assert.equal(out.expiresAt, new Date(now + JIT_DEPLOY_KEY_TTL_MS).toISOString());
  assert.match(out.privateKeyPem, /BEGIN OPENSSH PRIVATE KEY/);
});

test("a sweep that cannot reach Gitea never fails the caller", async () => {
  const gitea: any = {
    listDeployKeys: async () => { throw new Error("gitea down"); },
    deleteDeployKey: async () => { throw new Error("unreachable"); },
  };
  assert.equal(await sweepExpiredDeployKeys(gitea, "app-1"), 0);

  const stubborn: any = {
    listDeployKeys: async () => [{ id: 1, title: "jit-1-aaaa" }],
    deleteDeployKey: async () => { throw new Error("already gone"); },
  };
  assert.equal(await sweepExpiredDeployKeys(stubborn, "app-1"), 0);
});

test("actorJitDeployKeyIds picks only keys for that actor", () => {
  const actorId = "member-2";
  const now = 1_700_000_000_000;
  const keys = [
    { id: 1, title: jitDeployKeyTitle(actorId, now, "aaaa") },
    { id: 2, title: jitDeployKeyTitle("other-actor", now, "bbbb") },
    { id: 3, title: `jit-${now - 1}-legacy-other` },
    { id: 4, title: "a-humans-own-key" },
    { id: 5, title: jitDeployKeyTitle(actorId, now + 1, "cccc") },
  ];
  assert.deepEqual(actorJitDeployKeyIds(keys, actorId), [1, 5]);
});

test("revokeActorDeployKeys removes only that actor's JIT keys", async () => {
  const actorId = "member-2";
  const now = 1_700_000_000_000;
  const deleted: number[] = [];
  const gitea: any = {
    listDeployKeys: async () => [
      { id: 1, title: jitDeployKeyTitle(actorId, now, "aaaa") },
      { id: 2, title: jitDeployKeyTitle("other-actor", now, "bbbb") },
      { id: 3, title: "a-humans-own-key" },
      { id: 4, title: jitDeployKeyTitle(actorId, now + 1, "cccc") },
    ],
    deleteDeployKey: async (_appId: string, id: number) => { deleted.push(id); },
  };
  const removed = await revokeActorDeployKeys(gitea, "app-1", actorId);
  assert.equal(removed, 2);
  assert.deepEqual(deleted.sort(), [1, 4]);
});

test("revokeActorDeployKeys is best-effort when Gitea is unreachable", async () => {
  const gitea: any = {
    listDeployKeys: async () => { throw new Error("gitea down"); },
    deleteDeployKey: async () => { throw new Error("unreachable"); },
  };
  assert.equal(await revokeActorDeployKeys(gitea, "app-1", "member-2"), 0);

  const stubborn: any = {
    listDeployKeys: async () => [{ id: 1, title: jitDeployKeyTitle("member-2", Date.now()) }],
    deleteDeployKey: async () => { throw new Error("already gone"); },
  };
  assert.equal(await revokeActorDeployKeys(stubborn, "app-1", "member-2"), 0);
});

// ── returning a key when its holder is done ───────────────────────────────
//
// The sweep only runs when something asks the same repo for another key, so a
// repo nobody returns to keeps every key it was ever issued. `amuxd git-ssh`
// calls this as soon as ssh exits, which is what makes that residual small.

test("a holder returning its own key revokes it", async () => {
  const now = 1_700_000_000_000;
  const deleted: number[] = [];
  const gitea: any = {
    listDeployKeys: async () => [
      { id: 42, title: `jit-actor-1-${now - 1000}-aaaa` },
    ],
    deleteDeployKey: async (_appId: string, id: number) => { deleted.push(id); },
  };
  assert.equal(await revokeOwnJitDeployKey(gitea, "app-1", "actor-1", 42, now), true);
  assert.deepEqual(deleted, [42]);
});

test("a key belonging to another actor is never revoked", async () => {
  // Otherwise any team member could kill a push another machine is mid-way
  // through — denial of service dressed up as hygiene.
  const now = 1_700_000_000_000;
  const deleted: number[] = [];
  const gitea: any = {
    listDeployKeys: async () => [
      { id: 42, title: `jit-someone-else-${now - 1000}-aaaa` },
    ],
    deleteDeployKey: async (_appId: string, id: number) => { deleted.push(id); },
  };
  assert.equal(await revokeOwnJitDeployKey(gitea, "app-1", "actor-1", 42, now), false);
  assert.deepEqual(deleted, [], "another actor's live key stays");
});

test("returning a key also sweeps the expired ones on that repo", async () => {
  const now = 1_700_000_000_000;
  const deleted: number[] = [];
  const gitea: any = {
    listDeployKeys: async () => [
      { id: 1, title: `jit-actor-1-${now - JIT_DEPLOY_KEY_TTL_MS - 1}-aaaa` },
      { id: 2, title: `jit-someone-else-${now - JIT_DEPLOY_KEY_TTL_MS - 1}-bbbb` },
      { id: 3, title: `jit-someone-else-${now - 1000}-cccc` },
      { id: 42, title: `jit-actor-1-${now - 1000}-dddd` },
    ],
    deleteDeployKey: async (_appId: string, id: number) => { deleted.push(id); },
  };
  assert.equal(await revokeOwnJitDeployKey(gitea, "app-1", "actor-1", 42, now), true);
  // Both expired keys go regardless of whose they are — that is what the sweep
  // has always done — and the caller's own key goes last.
  assert.deepEqual(deleted, [1, 2, 42]);
  assert.ok(!deleted.includes(3), "another actor's live key stays");
});

test("returning a key that is already gone is not an error", async () => {
  const gitea: any = {
    listDeployKeys: async () => [],
    deleteDeployKey: async () => { throw new Error("gone"); },
  };
  assert.equal(await revokeOwnJitDeployKey(gitea, "app-1", "actor-1", 42), false);
});

test("a revoke that cannot reach Gitea never throws", async () => {
  const gitea: any = {
    listDeployKeys: async () => { throw new Error("gitea down"); },
    deleteDeployKey: async () => { throw new Error("unreachable"); },
  };
  assert.equal(await revokeOwnJitDeployKey(gitea, "app-1", "actor-1", 42), false);
});
