/**
 * Alibaba Cloud NLS (智能语音交互) credential minting.
 *
 * Backs `POST /v1/teams/:teamId/voice/credentials`, which is how the ESP32
 * voice terminal's daemon (amuxd) gets to speech recognition and synthesis.
 *
 * ## Why FC mints a token instead of proxying the audio
 *
 * The alternative was routing every Opus frame through this service and on to
 * the vendor. That would put a streaming-audio relay — WebSocket in, WebSocket
 * out — inside a container that today serves JSON REST, on the same 4-vCPU box
 * as Postgres, EMQX and MinIO, and would add a network hop to a latency budget
 * that is already tight (plan §9).
 *
 * Instead FC does what it already does for LiteLLM: hold the real credential,
 * hand back a scoped one. NLS's `CreateToken` is a perfect fit — the AccessKey
 * pair never leaves this process, and what amuxd receives expires on its own
 * (typically ~24h). Audio then goes straight from amuxd to the NLS gateway.
 *
 * DashScope/百炼 was the other candidate and was rejected for exactly this: it
 * authenticates with a long-lived `sk-` key and has no short-lived token to
 * mint, so "hand out a credential" would mean handing out the real key to every
 * user's machine.
 *
 * ## Credentials are a dedicated profile, never the default AccessKey
 *
 * `ACCESS_KEY_ID` / `ACCESS_KEY_SECRET` are **MinIO root credentials** on
 * self-host (see `provisioning/apps-oss.ts`, which learned this the hard way —
 * app deploys presigned code into MinIO with an Alibaba key and 403'd). Signing
 * an NLS request with them would fail in a way that names no variable, so
 * nothing here inherits them: voice reads `VOICE_*` or it refuses.
 *
 * ## Status
 *
 * The signing below follows Alibaba's RPC signature v1 spec but has **never
 * been run against the live API** — no AccessKey has been issued for this yet.
 * Treat `createNlsToken` as unverified on the wire; the signing is unit-tested
 * against the worked example in Alibaba's documentation, which is the strongest
 * check available without a key.
 */

import { createHmac, randomUUID } from "node:crypto";

type Env = NodeJS.ProcessEnv;

const trimmed = (v: string | undefined) => v?.trim() || "";

export interface VoiceProfile {
  accessKeyId: string;
  accessKeySecret: string;
  /** NLS is region-pinned; the gateway host is derived from this. */
  region: string;
  /** NLS project appkey. Identifies which project's models/quota to use. */
  appKey: string;
  /** `wss://…/ws/v1` — both ASR and TTS speak this one endpoint. */
  gatewayEndpoint: string;
  /** Streaming ASR model, e.g. `paraformer-realtime-v2`. */
  sttModel: string;
  /**
   * TTS voice id, e.g. `zhixiaobai` / `xiaoyun` / `siqi` / `aixia`.
   *
   * These are classic NLS voice names. CosyVoice/DashScope names such as
   * `longxiaochun` are a DIFFERENT product and the gateway rejects them with
   * `TtsClientError: Engine return error code: 418` (observed 2026-08-25).
   */
  ttsVoice: string;
}

export type VoiceResolution =
  | { profile: VoiceProfile; error?: undefined }
  | { profile?: undefined; error: string };

/** Default NLS region. Shanghai is where the speech models are published. */
const DEFAULT_REGION = "cn-shanghai";

/**
 * Resolve the voice profile, or explain precisely what is missing.
 *
 * Returning the reason rather than a bare null follows `resolveAppsOss`: the
 * failure it replaced surfaced as "provisioning not configured", named no
 * variable, and cost an SSH session to diagnose.
 */
export function resolveVoiceProfile(env: Env = process.env): VoiceResolution {
  const accessKeyId = trimmed(env.VOICE_ACCESS_KEY_ID);
  if (!accessKeyId) {
    return {
      error:
        "VOICE_ACCESS_KEY_ID is not set. Voice deliberately does not fall back to ACCESS_KEY_ID, which is the MinIO root credential on self-host.",
    };
  }
  const accessKeySecret = trimmed(env.VOICE_ACCESS_KEY_SECRET);
  if (!accessKeySecret) {
    return { error: "VOICE_ACCESS_KEY_ID is set but VOICE_ACCESS_KEY_SECRET is empty" };
  }
  const appKey = trimmed(env.VOICE_NLS_APPKEY);
  if (!appKey) {
    return {
      error:
        "VOICE_ACCESS_KEY_ID is set but VOICE_NLS_APPKEY is empty — NLS rejects every request without a project appkey",
    };
  }
  const region = trimmed(env.VOICE_REGION) || DEFAULT_REGION;
  return {
    profile: {
      accessKeyId,
      accessKeySecret,
      region,
      appKey,
      gatewayEndpoint:
        trimmed(env.VOICE_NLS_GATEWAY) || `wss://nls-gateway-${region}.aliyuncs.com/ws/v1`,
      sttModel: trimmed(env.VOICE_STT_MODEL) || "paraformer-realtime-v2",
      ttsVoice: trimmed(env.VOICE_TTS_VOICE) || "zhixiaobai",
    },
  };
}

/**
 * RFC3986 percent-encoding, which is stricter than `encodeURIComponent`.
 *
 * `encodeURIComponent` leaves `!'()*` alone; RFC3986 treats them as reserved,
 * and Alibaba's signer expects them encoded. Getting this wrong produces a
 * signature mismatch on exactly the inputs that contain those characters —
 * which is rare enough to pass a smoke test and fail later.
 */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * Alibaba RPC signature v1.
 *
 * `StringToSign = METHOD & percentEncode("/") & percentEncode(sortedQuery)`,
 * signed HMAC-SHA1 with `secret + "&"`. The trailing `&` on the key is not a
 * typo — it is part of the spec.
 */
export function signRpcRequest(
  method: string,
  params: Record<string, string>,
  accessKeySecret: string,
): string {
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join("&");
  const stringToSign = `${method}&${percentEncode("/")}&${percentEncode(canonical)}`;
  return createHmac("sha1", `${accessKeySecret}&`).update(stringToSign).digest("base64");
}

export interface NlsToken {
  token: string;
  /** ISO-8601. NLS reports a unix timestamp in seconds; converted here. */
  expiresAt: string;
}

/** Injectable so tests exercise signing and parsing without network access. */
export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Mint a short-lived NLS token via the `CreateToken` RPC.
 *
 * `nonce` and `timestamp` are injectable purely so the signature is
 * reproducible in tests; production leaves them to be generated.
 */
export async function createNlsToken(
  profile: VoiceProfile,
  opts: { fetchImpl?: FetchLike; nonce?: string; timestamp?: string } = {},
): Promise<NlsToken> {
  const params: Record<string, string> = {
    AccessKeyId: profile.accessKeyId,
    Action: "CreateToken",
    Format: "JSON",
    RegionId: profile.region,
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: opts.nonce ?? randomUUID(),
    SignatureVersion: "1.0",
    Timestamp: opts.timestamp ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    Version: "2019-02-28",
  };
  const signature = signRpcRequest("GET", params, profile.accessKeySecret);
  const query = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join("&");
  const url = `https://nls-meta.${profile.region}.aliyuncs.com/?Signature=${percentEncode(
    signature,
  )}&${query}`;

  const doFetch = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const res = await doFetch(url);
  const body = await res.text();
  if (!res.ok) {
    // The AccessKey must never reach a log line or an API response.
    throw new Error(`NLS CreateToken failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  let parsed: { Token?: { Id?: string; ExpireTime?: number } };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`NLS CreateToken returned non-JSON: ${body.slice(0, 200)}`);
  }
  const id = parsed.Token?.Id;
  if (!id) {
    throw new Error(`NLS CreateToken returned no token: ${body.slice(0, 200)}`);
  }
  const expire = parsed.Token?.ExpireTime;
  return {
    token: id,
    expiresAt:
      typeof expire === "number" && Number.isFinite(expire)
        ? new Date(expire * 1000).toISOString()
        : // No expiry reported: claim a conservative one rather than none, so a
          // client that refreshes on `expiresAt` still refreshes.
          new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
}
