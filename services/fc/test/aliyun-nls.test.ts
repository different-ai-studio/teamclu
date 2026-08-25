import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createNlsToken,
  percentEncode,
  resolveVoiceProfile,
  signRpcRequest,
  type VoiceProfile,
} from "../src/lib/aliyun-nls.js";

// The signing here has never run against the live NLS API — no AccessKey has
// been issued yet. These tests are the strongest check available without one:
// the signature is pinned against Alibaba's own worked example, and the profile
// resolution is pinned against the specific misconfiguration that took down app
// deploys (inheriting the default AccessKey, which is MinIO's on self-host).

// ---------------------------------------------------------------------------
// Percent-encoding
// ---------------------------------------------------------------------------

test("percentEncode escapes the characters encodeURIComponent leaves alone", () => {
  // This is the whole reason the helper exists. encodeURIComponent passes
  // !'()* through untouched; Alibaba's signer expects them encoded, so a
  // parameter containing one would produce a signature mismatch on exactly
  // those inputs — rare enough to survive a smoke test.
  assert.equal(percentEncode("!'()*"), "%21%27%28%29%2A");
});

test("percentEncode leaves RFC3986 unreserved characters alone", () => {
  assert.equal(percentEncode("aZ0-_.~"), "aZ0-_.~");
});

test("percentEncode encodes space as %20, never +", () => {
  // A `+` here would be read back as a literal plus by the server and the
  // signature would not match.
  assert.equal(percentEncode("a b"), "a%20b");
});

test("percentEncode escapes the separators that would corrupt the query", () => {
  assert.equal(percentEncode("a&b=c/d"), "a%26b%3Dc%2Fd");
});

// ---------------------------------------------------------------------------
// RPC signature v1
// ---------------------------------------------------------------------------

test("signRpcRequest reproduces Alibaba's documented worked example", () => {
  // From Alibaba's RPC signature documentation. If this drifts, every
  // CreateToken call returns SignatureDoesNotMatch and no local test would
  // otherwise notice.
  const params: Record<string, string> = {
    AccessKeyId: "testid",
    Action: "DescribeRegions",
    Format: "XML",
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: "3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf",
    SignatureVersion: "1.0",
    Timestamp: "2016-02-23T12:46:24Z",
    Version: "2014-05-26",
  };
  assert.equal(
    signRpcRequest("GET", params, "testsecret"),
    "OLeaidS1JvxuMvnyHOwuJ+uX5qY=",
  );
});

test("signRpcRequest sorts parameters, so declaration order cannot change it", () => {
  const a = { B: "2", A: "1", C: "3" };
  const b = { C: "3", A: "1", B: "2" };
  assert.equal(signRpcRequest("GET", a, "s"), signRpcRequest("GET", b, "s"));
});

test("signRpcRequest depends on the secret", () => {
  const params = { A: "1" };
  assert.notEqual(signRpcRequest("GET", params, "s1"), signRpcRequest("GET", params, "s2"));
});

// ---------------------------------------------------------------------------
// Profile resolution
// ---------------------------------------------------------------------------

const fullEnv = {
  VOICE_ACCESS_KEY_ID: "LTAI_voice",
  VOICE_ACCESS_KEY_SECRET: "voice-secret",
  VOICE_NLS_APPKEY: "appkey-1",
} as NodeJS.ProcessEnv;

test("resolveVoiceProfile refuses to inherit the default AccessKey", () => {
  // The failure this prevents: on self-host ACCESS_KEY_ID/SECRET are MinIO's
  // root credentials. Falling back to them would sign an NLS request with a
  // MinIO key and fail upstream, naming nothing.
  const { profile, error } = resolveVoiceProfile({
    ACCESS_KEY_ID: "minio-root",
    ACCESS_KEY_SECRET: "minio-secret",
  } as NodeJS.ProcessEnv);
  assert.equal(profile, undefined);
  assert.match(error!, /VOICE_ACCESS_KEY_ID is not set/);
  assert.match(error!, /MinIO/, "the error must explain why, not just what");
});

test("resolveVoiceProfile names the specific missing variable", () => {
  // "not configured" naming nothing is what made the app-deploy failure cost
  // an SSH session to diagnose.
  const noSecret = resolveVoiceProfile({
    VOICE_ACCESS_KEY_ID: "k",
  } as NodeJS.ProcessEnv);
  assert.match(noSecret.error!, /VOICE_ACCESS_KEY_SECRET is empty/);

  const noAppKey = resolveVoiceProfile({
    VOICE_ACCESS_KEY_ID: "k",
    VOICE_ACCESS_KEY_SECRET: "s",
  } as NodeJS.ProcessEnv);
  assert.match(noAppKey.error!, /VOICE_NLS_APPKEY is empty/);
});

test("resolveVoiceProfile treats blank and whitespace-only as unset", () => {
  // A blank line in .env reaches the process as "", and compose's :- default
  // does not cover an explicitly-empty value.
  for (const blank of ["", "   "]) {
    const { profile } = resolveVoiceProfile({
      ...fullEnv,
      VOICE_ACCESS_KEY_ID: blank,
    } as NodeJS.ProcessEnv);
    assert.equal(profile, undefined, `${JSON.stringify(blank)} must be treated as unset`);
  }
});

test("resolveVoiceProfile derives the gateway from the region", () => {
  const { profile } = resolveVoiceProfile(fullEnv);
  assert.equal(profile!.region, "cn-shanghai");
  assert.equal(profile!.gatewayEndpoint, "wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1");
  assert.equal(profile!.sttModel, "paraformer-realtime-v2");
  assert.equal(profile!.ttsVoice, "zhixiaobai");
});

test("resolveVoiceProfile honours explicit overrides", () => {
  const { profile } = resolveVoiceProfile({
    ...fullEnv,
    VOICE_REGION: "cn-beijing",
    VOICE_NLS_GATEWAY: "wss://custom/ws/v1",
    VOICE_STT_MODEL: "paraformer-realtime-8k-v2",
    VOICE_TTS_VOICE: "zhixiaobai",
  } as NodeJS.ProcessEnv);
  assert.equal(profile!.gatewayEndpoint, "wss://custom/ws/v1");
  assert.equal(profile!.sttModel, "paraformer-realtime-8k-v2");
  assert.equal(profile!.ttsVoice, "zhixiaobai");
});

test("a region override without a gateway override still moves the gateway", () => {
  // Otherwise a Beijing deployment would sign for Beijing and connect to
  // Shanghai.
  const { profile } = resolveVoiceProfile({
    ...fullEnv,
    VOICE_REGION: "cn-beijing",
  } as NodeJS.ProcessEnv);
  assert.equal(profile!.gatewayEndpoint, "wss://nls-gateway-cn-beijing.aliyuncs.com/ws/v1");
});

// ---------------------------------------------------------------------------
// CreateToken
// ---------------------------------------------------------------------------

const profile: VoiceProfile = {
  accessKeyId: "LTAI_voice",
  accessKeySecret: "voice-secret",
  region: "cn-shanghai",
  appKey: "appkey-1",
  gatewayEndpoint: "wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1",
  sttModel: "paraformer-realtime-v2",
  ttsVoice: "zhixiaobai",
};

function stubFetch(status: number, body: string, seen?: { url?: string }) {
  return async (url: string) => {
    if (seen) seen.url = url;
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
}

test("createNlsToken returns the token and converts the expiry to ISO", () => {
  const expire = 1_800_000_000; // seconds
  return createNlsToken(profile, {
    fetchImpl: stubFetch(200, JSON.stringify({ Token: { Id: "tok-1", ExpireTime: expire } })),
  }).then((t) => {
    assert.equal(t.token, "tok-1");
    assert.equal(t.expiresAt, new Date(expire * 1000).toISOString());
  });
});

test("createNlsToken signs the request and never puts the secret in the URL", async () => {
  const seen: { url?: string } = {};
  await createNlsToken(profile, {
    fetchImpl: stubFetch(200, JSON.stringify({ Token: { Id: "t", ExpireTime: 1 } }), seen),
    nonce: "fixed-nonce",
    timestamp: "2026-08-25T00:00:00Z",
  });
  assert.match(seen.url!, /^https:\/\/nls-meta\.cn-shanghai\.aliyuncs\.com\/\?Signature=/);
  assert.match(seen.url!, /Action=CreateToken/);
  assert.match(seen.url!, /AccessKeyId=LTAI_voice/);
  assert.ok(
    !seen.url!.includes("voice-secret"),
    "the AccessKey SECRET must never appear in the request URL",
  );
});

test("createNlsToken is deterministic for a fixed nonce and timestamp", async () => {
  // Guards the signing inputs: if a parameter is added, removed or renamed the
  // signature changes, and this is the only place that would notice before the
  // vendor rejects it.
  const seen: { url?: string } = {};
  await createNlsToken(profile, {
    fetchImpl: stubFetch(200, JSON.stringify({ Token: { Id: "t", ExpireTime: 1 } }), seen),
    nonce: "fixed-nonce",
    timestamp: "2026-08-25T00:00:00Z",
  });
  const sig = new URL(seen.url!).searchParams.get("Signature");
  assert.equal(sig, "/wes43a/T/uKFOLHvvltIapY5pk=");
});

test("createNlsToken surfaces an HTTP failure without leaking the whole body", async () => {
  await assert.rejects(
    () => createNlsToken(profile, { fetchImpl: stubFetch(403, "x".repeat(5000)) }),
    (e: Error) => {
      assert.match(e.message, /HTTP 403/);
      assert.ok(e.message.length < 300, "the upstream body must be truncated");
      return true;
    },
  );
});

test("createNlsToken rejects a non-JSON body", async () => {
  await assert.rejects(
    () => createNlsToken(profile, { fetchImpl: stubFetch(200, "<html>gateway</html>") }),
    /non-JSON/,
  );
});

test("createNlsToken rejects a 200 that carries no token", async () => {
  // A success status with a missing Id would otherwise hand the daemon
  // `undefined` as its credential and fail much later, at the gateway.
  await assert.rejects(
    () => createNlsToken(profile, { fetchImpl: stubFetch(200, JSON.stringify({ Token: {} })) }),
    /returned no token/,
  );
});

test("createNlsToken invents a conservative expiry when none is reported", async () => {
  // Never return an absent expiry: a client that refreshes on `expiresAt`
  // would then never refresh.
  const before = Date.now();
  const t = await createNlsToken(profile, {
    fetchImpl: stubFetch(200, JSON.stringify({ Token: { Id: "t" } })),
  });
  const at = new Date(t.expiresAt).getTime();
  assert.ok(at > before, "expiry must be in the future");
  assert.ok(at <= before + 61 * 60 * 1000, "and not wildly far out");
});
