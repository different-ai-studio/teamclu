// WeCom callback message crypto (the scheme WeCom's WXBizMsgCrypt implements).
//
// Every callback WeCom sends a service provider — the suite_ticket push, the
// install / uninstall notices, and the URL verification probe — carries an
// AES-256-CBC ciphertext and a SHA-1 signature:
//
//   msg_signature = sha1(sort([token, timestamp, nonce, encrypt]).join(""))
//   key           = base64(EncodingAESKey + "="), 32 bytes; iv = key[0..16]
//   plaintext     = random(16) | len(4, big-endian) | msg | receiveId
//   padding       = PKCS#7 with a 32-byte block
//
// receiveId is the SuiteID for third-party app callbacks (and the provider
// CorpID for some provider-level ones), so callers pass the set they accept.
import crypto from "crypto";

export class WecomCryptoError extends Error {}

export interface WecomCryptoConfig {
  token: string;
  encodingAesKey: string;
}

function aesKey(encodingAesKey: string): Buffer {
  const key = Buffer.from(`${encodingAesKey}=`, "base64");
  if (key.length !== 32) throw new WecomCryptoError("EncodingAESKey must decode to 32 bytes");
  return key;
}

export function wecomSignature(token: string, timestamp: string, nonce: string, encrypt: string): string {
  return crypto
    .createHash("sha1")
    .update([token, timestamp, nonce, encrypt].sort().join(""))
    .digest("hex");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function verifyWecomSignature(
  cfg: WecomCryptoConfig,
  args: { signature: string; timestamp: string; nonce: string; encrypt: string },
): boolean {
  const expected = wecomSignature(cfg.token, args.timestamp, args.nonce, args.encrypt);
  return timingSafeEqualHex(expected, (args.signature ?? "").toLowerCase());
}

export function decryptWecomMessage(
  cfg: WecomCryptoConfig,
  encrypt: string,
): { message: string; receiveId: string } {
  const key = aesKey(cfg.encodingAesKey);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(Buffer.from(encrypt, "base64")), decipher.final()]);
  } catch {
    throw new WecomCryptoError("ciphertext could not be decrypted");
  }
  const pad = plain[plain.length - 1];
  if (!pad || pad > 32 || pad > plain.length) throw new WecomCryptoError("bad padding");
  plain = plain.subarray(0, plain.length - pad);
  if (plain.length < 20) throw new WecomCryptoError("plaintext too short");
  const len = plain.readUInt32BE(16);
  if (20 + len > plain.length) throw new WecomCryptoError("bad message length");
  return {
    message: plain.subarray(20, 20 + len).toString("utf8"),
    receiveId: plain.subarray(20 + len).toString("utf8"),
  };
}

/** The inverse of decryptWecomMessage. FC never replies encrypted; tests use it. */
export function encryptWecomMessage(
  cfg: WecomCryptoConfig,
  message: string,
  receiveId: string,
  random: Buffer = crypto.randomBytes(16),
): string {
  const key = aesKey(cfg.encodingAesKey);
  const msg = Buffer.from(message, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(msg.length, 0);
  const body = Buffer.concat([random, len, msg, Buffer.from(receiveId, "utf8")]);
  const pad = 32 - (body.length % 32);
  const padded = Buffer.concat([body, Buffer.alloc(pad, pad)]);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

/**
 * Verify and decrypt one callback payload. Throws WecomCryptoError on a bad
 * signature, a bad ciphertext, or a receiveId outside `acceptReceiveIds`.
 * `acceptReceiveIds: "any"` is for data callbacks, which carry each customer
 * company's corpid: the signature over our Token is what authenticates them.
 */
export function openWecomCallback(
  cfg: WecomCryptoConfig,
  args: { signature: string; timestamp: string; nonce: string; encrypt: string },
  acceptReceiveIds: string[] | "any",
): string {
  if (!verifyWecomSignature(cfg, args)) throw new WecomCryptoError("signature mismatch");
  const { message, receiveId } = decryptWecomMessage(cfg, args.encrypt);
  if (acceptReceiveIds !== "any" && !acceptReceiveIds.includes(receiveId)) {
    throw new WecomCryptoError(`unexpected receiveId ${JSON.stringify(receiveId)}`);
  }
  return message;
}

/**
 * The text of one top-level element of a WeCom callback XML. WeCom's callback
 * documents are flat (`<xml><Name>value</Name>...</xml>`, values optionally in
 * CDATA), so a full XML parser would buy nothing but a dependency.
 */
export function xmlField(xml: string, name: string): string | null {
  const re = new RegExp(`<${name}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))\\s*</${name}>`);
  const m = re.exec(xml);
  if (!m) return null;
  return (m[1] ?? m[2] ?? "").trim();
}
