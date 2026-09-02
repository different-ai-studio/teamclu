import { generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from "node:crypto";

import type { GiteaClient } from "./gitea.js";

export type DeployKeyPair = {
  /** OpenSSH single-line public key for Gitea deploy key registration. */
  publicKeyOpenSSH: string;
  /**
   * OpenSSH-format private key (`-----BEGIN OPENSSH PRIVATE KEY-----`).
   *
   * NOT PKCS#8. OpenSSH's PEM loader only accepts RSA/DSA/EC in a
   * `BEGIN PRIVATE KEY` block and rejects an Ed25519 one with
   * SSH_ERR_INVALID_FORMAT — so a PKCS#8 export here made every `ssh -i` git
   * push and fetch fail with "Load key: invalid format".
   */
  privateKeyPem: string;
};

/** `uint32 length` + payload — the SSH wire encoding for strings and blobs. */
function sshString(payload: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length);
  return Buffer.concat([len, payload]);
}

function uint32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

const OPENSSH_MAGIC = Buffer.from("openssh-key-v1\0", "binary");
const KEY_TYPE = "ssh-ed25519";
/** Unencrypted keys still pad to the "none" cipher's 8-byte block. */
const OPENSSH_BLOCK_SIZE = 8;
const PEM_LINE_WIDTH = 70;

/** Encode a raw key blob in OpenSSH authorized_keys / deploy-key wire format. */
function encodeOpenSshPublicKey(rawPublicKey: Buffer, keyType: string): string {
  const wire = Buffer.concat([
    sshString(Buffer.from(keyType)),
    sshString(rawPublicKey),
  ]);
  return `${keyType} ${wire.toString("base64")}`;
}

/** Extract the 32-byte Ed25519 public key from an SPKI DER blob. */
function ed25519RawFromSpkiDer(der: Buffer): Buffer {
  if (der.length < 32) {
    throw new Error("invalid ed25519 SPKI: too short");
  }
  return der.subarray(der.length - 32);
}

/** Extract the 32-byte Ed25519 seed from a PKCS#8 DER blob. */
function ed25519SeedFromPkcs8Der(der: Buffer): Buffer {
  if (der.length < 32) {
    throw new Error("invalid ed25519 PKCS#8: too short");
  }
  return der.subarray(der.length - 32);
}

function pemWrap(label: string, body: Buffer): string {
  const b64 = body.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += PEM_LINE_WIDTH) {
    lines.push(b64.slice(i, i + PEM_LINE_WIDTH));
  }
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/**
 * Build an unencrypted OpenSSH private key file for an Ed25519 key.
 *
 * Layout (PROTOCOL.key): magic, ciphername/kdfname/kdfoptions, key count,
 * the public blob, then a length-prefixed private section holding a repeated
 * check int, the key itself (`priv = seed || public`), a comment, and 1,2,3…
 * padding to the cipher block size.
 */
function encodeOpenSshPrivateKey(
  rawPublicKey: Buffer,
  seed: Buffer,
  comment = "",
): string {
  const publicBlob = Buffer.concat([
    sshString(Buffer.from(KEY_TYPE)),
    sshString(rawPublicKey),
  ]);
  const check = randomBytes(4);
  const unpadded = Buffer.concat([
    check,
    check,
    sshString(Buffer.from(KEY_TYPE)),
    sshString(rawPublicKey),
    sshString(Buffer.concat([seed, rawPublicKey])),
    sshString(Buffer.from(comment)),
  ]);
  const padLength = (OPENSSH_BLOCK_SIZE - (unpadded.length % OPENSSH_BLOCK_SIZE)) % OPENSSH_BLOCK_SIZE;
  const padding = Buffer.from(Array.from({ length: padLength }, (_, i) => i + 1));

  const body = Buffer.concat([
    OPENSSH_MAGIC,
    sshString(Buffer.from("none")), // ciphername
    sshString(Buffer.from("none")), // kdfname
    sshString(Buffer.alloc(0)), // kdfoptions
    uint32(1), // number of keys
    sshString(publicBlob),
    sshString(Buffer.concat([unpadded, padding])),
  ]);
  return pemWrap("OPENSSH PRIVATE KEY", body);
}

export function generateDeployKeyPair(comment = "teamclu-app-deploy"): DeployKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519") as {
    publicKey: KeyObject;
    privateKey: KeyObject;
  };
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const rawPublicKey = ed25519RawFromSpkiDer(spki);
  return {
    publicKeyOpenSSH: encodeOpenSshPublicKey(rawPublicKey, KEY_TYPE),
    privateKeyPem: encodeOpenSshPrivateKey(
      rawPublicKey,
      ed25519SeedFromPkcs8Der(pkcs8),
      comment,
    ),
  };
}

// ── JIT deploy keys ────────────────────────────────────────────────────────
//
// Each request mints a fresh key and hands its private half to one holder.
//
// Holders that can say "done with it" do: `amuxd git-ssh` revokes its own key
// as soon as ssh exits (`revokeOwnJitDeployKey`), which is the normal path for
// an agent's `git push` and leaves nothing behind at all.
//
// The expiry sweep is the backstop for holders that cannot — a desktop seed or
// deploy that dies mid-flight, or a revoke that fails. It only runs when some
// request touches the same repo again, so a repo nobody comes back to keeps
// whatever it was left holding; that is the residual, and it is why revoking
// at the holder matters rather than being an optimisation.

/** How long a JIT deploy key is advertised as usable. */
export const JIT_DEPLOY_KEY_TTL_MS = 15 * 60 * 1000;
const JIT_TITLE_PREFIX = "jit-";

/**
 * Title for a freshly minted JIT key: prefix, actor, mint time, and a nonce.
 *
 * The nonce is what keeps two credential requests in the same millisecond from
 * colliding on Gitea's unique-title constraint.
 */
export function jitDeployKeyTitle(
  actorId: string,
  now = Date.now(),
  nonce = randomUUID().slice(0, 8),
): string {
  return `${JIT_TITLE_PREFIX}${actorId}-${now}-${nonce}`;
}

/** Extract mint timestamp from a JIT title, or null if unparseable. */
function jitTitleMintedAt(title: string): number | null {
  if (!title.startsWith(JIT_TITLE_PREFIX)) return null;
  const rest = title.slice(JIT_TITLE_PREFIX.length);
  if (/^\d+$/.test(rest)) return Number.parseInt(rest, 10);

  const lastDash = rest.lastIndexOf("-");
  if (lastDash <= 0) return null;
  const beforeNonce = rest.slice(0, lastDash);
  const secondLastDash = beforeNonce.lastIndexOf("-");
  const msStr = secondLastDash < 0 ? beforeNonce : beforeNonce.slice(secondLastDash + 1);
  if (!/^\d+$/.test(msStr)) return null;
  const mintedAt = Number.parseInt(msStr, 10);
  return Number.isFinite(mintedAt) ? mintedAt : null;
}

/** ids of JIT keys minted longer than `ttlMs` ago. Foreign titles are left alone. */
export function expiredJitDeployKeyIds(
  keys: { id: number; title: string }[],
  now = Date.now(),
  ttlMs = JIT_DEPLOY_KEY_TTL_MS,
): number[] {
  return keys
    .filter((k) => {
      const mintedAt = jitTitleMintedAt(k.title);
      if (mintedAt === null) return false;
      return now - mintedAt > ttlMs;
    })
    .map((k) => k.id);
}

/**
 * Revoke expired JIT keys on an app's repo.
 *
 * Best effort throughout: a repo we cannot list, or a key we cannot delete, is
 * not a reason to fail the credential request the caller actually made.
 */
export async function sweepExpiredDeployKeys(
  gitea: GiteaClient,
  appId: string,
  now = Date.now(),
): Promise<number> {
  let keys: { id: number; title: string }[];
  try {
    keys = await gitea.listDeployKeys(appId);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const id of expiredJitDeployKeyIds(keys, now)) {
    try {
      await gitea.deleteDeployKey(appId, id);
      removed += 1;
    } catch {
      // Another request may have swept it already.
    }
  }
  return removed;
}

/** Prefix for JIT deploy keys belonging to one actor (`jit-${actorId}-…`). */
function jitActorKeyPrefix(actorId: string): string {
  return `${JIT_TITLE_PREFIX}${actorId}-`;
}

/** ids of JIT keys whose title belongs to `actorId`. Foreign titles are left alone. */
export function actorJitDeployKeyIds(
  keys: { id: number; title: string }[],
  actorId: string,
): number[] {
  const prefix = jitActorKeyPrefix(actorId);
  return keys.filter((k) => k.title.startsWith(prefix)).map((k) => k.id);
}

/**
 * Hand one JIT key back the moment its holder is done with it.
 *
 * This is what turns the expiry sweep from the only bound on live credentials
 * into a backstop. A key is only revocable by the actor whose title it carries:
 * without that check any team member could revoke a key another machine is
 * mid-push with, which is a denial of service dressed as hygiene.
 *
 * Returns false when the key is not this actor's (or is already gone) — the
 * caller reports success either way, because "the key is not usable any more"
 * is the outcome being asked for.
 */
export async function revokeOwnJitDeployKey(
  gitea: GiteaClient,
  appId: string,
  actorId: string,
  deployKeyId: number,
  now = Date.now(),
): Promise<boolean> {
  let keys: { id: number; title: string }[];
  try {
    keys = await gitea.listDeployKeys(appId);
  } catch {
    return false;
  }
  // The listing is already paid for, so sweep the expired ones while we hold
  // it. This is the only place a quiet repo gets tidied without a fresh mint.
  for (const id of expiredJitDeployKeyIds(keys, now)) {
    if (id === deployKeyId) continue;
    try {
      await gitea.deleteDeployKey(appId, id);
    } catch {
      // Another request may have swept it already.
    }
  }

  const target = keys.find((k) => k.id === deployKeyId);
  if (!target || !target.title.startsWith(jitActorKeyPrefix(actorId))) {
    return false;
  }
  try {
    await gitea.deleteDeployKey(appId, deployKeyId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Revoke every deploy key on an app's repo (§7.2 delete).
 *
 * Best effort throughout — a missing repo or a stubborn key must not block delete.
 */
export async function revokeAllDeployKeys(
  gitea: GiteaClient,
  appId: string,
): Promise<number> {
  let keys: { id: number; title: string }[];
  try {
    keys = await gitea.listDeployKeys(appId);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const { id } of keys) {
    try {
      await gitea.deleteDeployKey(appId, id);
      removed += 1;
    } catch {
      // Another request may have removed it already.
    }
  }
  return removed;
}

/**
 * Revoke all JIT deploy keys for an actor on an app's repo.
 *
 * Best effort throughout: a repo we cannot list, or a key we cannot delete, is
 * not a reason to fail the deauth the caller actually made.
 */
export async function revokeActorDeployKeys(
  gitea: GiteaClient,
  appId: string,
  actorId: string,
): Promise<number> {
  let keys: { id: number; title: string }[];
  try {
    keys = await gitea.listDeployKeys(appId);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const id of actorJitDeployKeyIds(keys, actorId)) {
    try {
      await gitea.deleteDeployKey(appId, id);
      removed += 1;
    } catch {
      // Another request may have removed it already.
    }
  }
  return removed;
}

/** Sweep expired keys, then register a fresh one and return its private half. */
export async function issueJitDeployKey(
  gitea: GiteaClient,
  appId: string,
  actorId: string,
  now = Date.now(),
): Promise<{ privateKeyPem: string; deployKeyId: number; expiresAt: string }> {
  await sweepExpiredDeployKeys(gitea, appId, now);
  const { publicKeyOpenSSH, privateKeyPem } = generateDeployKeyPair();
  const { id } = await gitea.createDeployKey(appId, jitDeployKeyTitle(actorId, now), publicKeyOpenSSH);
  return {
    privateKeyPem,
    deployKeyId: id,
    expiresAt: new Date(now + JIT_DEPLOY_KEY_TTL_MS).toISOString(),
  };
}

/** @internal test helper — validate an OpenSSH public key string parses. */
export function parseOpenSshPublicKey(line: string): { keyType: string; raw: Buffer } {
  const [keyType, b64] = line.trim().split(/\s+/);
  if (!keyType || !b64) throw new Error("invalid OpenSSH public key line");
  const wire = Buffer.from(b64, "base64");
  let offset = 0;
  const readLenPrefixed = () => {
    const len = wire.readUInt32BE(offset);
    offset += 4;
    const slice = wire.subarray(offset, offset + len);
    offset += len;
    return slice;
  };
  const type = readLenPrefixed().toString();
  const raw = readLenPrefixed();
  if (type !== keyType) throw new Error("key type mismatch");
  return { keyType, raw };
}

/**
 * @internal test helper — parse an unencrypted OpenSSH private key file back
 * into its parts, so a test can prove the bytes really are what OpenSSH reads.
 */
export function parseOpenSshPrivateKey(pem: string): {
  keyType: string;
  publicKey: Buffer;
  seed: Buffer;
  comment: string;
} {
  const match = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]+?)-----END OPENSSH PRIVATE KEY-----/.exec(pem);
  if (!match) throw new Error("not an OpenSSH private key");
  const blob = Buffer.from(match[1].replace(/\s+/g, ""), "base64");
  if (!blob.subarray(0, OPENSSH_MAGIC.length).equals(OPENSSH_MAGIC)) {
    throw new Error("bad openssh-key-v1 magic");
  }
  let offset = OPENSSH_MAGIC.length;
  const readString = () => {
    const len = blob.readUInt32BE(offset);
    offset += 4;
    const slice = blob.subarray(offset, offset + len);
    offset += len;
    return slice;
  };
  const cipher = readString().toString();
  const kdf = readString().toString();
  readString(); // kdfoptions
  const keyCount = blob.readUInt32BE(offset);
  offset += 4;
  if (cipher !== "none" || kdf !== "none") throw new Error("key is encrypted");
  if (keyCount !== 1) throw new Error(`unexpected key count ${keyCount}`);
  readString(); // public blob
  const priv = readString();

  let p = 0;
  const readPrivString = () => {
    const len = priv.readUInt32BE(p);
    p += 4;
    const slice = priv.subarray(p, p + len);
    p += len;
    return slice;
  };
  const check1 = priv.readUInt32BE(0);
  const check2 = priv.readUInt32BE(4);
  if (check1 !== check2) throw new Error("check ints differ (wrong passphrase?)");
  p = 8;
  const keyType = readPrivString().toString();
  const publicKey = readPrivString();
  const secret = readPrivString();
  const comment = readPrivString().toString();
  return { keyType, publicKey, seed: secret.subarray(0, 32), comment };
}
