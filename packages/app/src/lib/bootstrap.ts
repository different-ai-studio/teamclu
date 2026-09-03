import { appShortName } from "@/lib/build-config";
import { applyRemoteFeatures } from "@/lib/remote-features";
import {
  getEffectiveServerConfig,
  getSavedServerConfig,
  saveServerConfig,
  type ServerConfig,
} from "@/lib/server-config";
import { isTauri } from "@/lib/utils";

interface BootstrapMqttPayload {
  url?: string;
  /**
   * Raw-TCP broker address (mqtt://host:port), for clients whose MQTT stack
   * cannot do WebSocket — iOS (CocoaMQTT) and Expo prefer it over `url`.
   *
   * The desktop does NOT: its rumqttc client is built with the `websocket`
   * feature (see `apps/desktop/Cargo.toml` and the `is_websocket()` branch in
   * `apps/desktop/src/mqtt/client.rs`), so the canonical public `url` wins here
   * and `tcpUrl` is only a fallback. The daemon resolves it the same way. Keep
   * the two families' preferences deliberate rather than accidentally aligned.
   */
  tcpUrl?: string | null;
  username?: string | null;
  password?: string | null;
  useTls?: boolean | null;
}

interface BootstrapWebSsoPayload {
  loginUrl?: string;
  storageKey?: string | null;
}

interface BootstrapPayload {
  mqtt?: BootstrapMqttPayload;
  webSso?: BootstrapWebSsoPayload;
  /**
   * Runtime feature overrides. Which flags arrive depends on the endpoint:
   * `/v1/config/public` carries `auth` (the login screen needs it before any
   * token exists) and `/v1/config/bootstrap` carries the rest. Each key has one
   * authoritative endpoint — see lib/remote-features.ts.
   */
  features?: unknown;
}

/**
 * Identifies the calling build to the Cloud API. Nothing depends on it yet: it
 * exists so a per-brand or version-gated rollout is a server-side change later,
 * rather than waiting on a client release to start sending the parameters.
 */
function callerQuery(): string {
  const params = new URLSearchParams({
    brand: appShortName,
    platform: isTauri() ? "desktop" : "web",
  });
  const version = import.meta.env.PACKAGE_VERSION;
  if (version) params.set("version", String(version));
  return `?${params.toString()}`;
}

function parseBrokerUrl(raw: string): { host: string; port?: number; useTls?: boolean } | null {
  try {
    const url = new URL(raw);
    const scheme = url.protocol.replace(/:$/, "");
    const useTls = scheme === "mqtts" || scheme === "wss";
    const port = url.port ? Number(url.port) : undefined;
    if (!url.hostname) return null;
    return { host: url.hostname, port: Number.isFinite(port) ? port : undefined, useTls };
  } catch {
    return null;
  }
}

function patchFromPayload(mqtt: BootstrapMqttPayload | undefined): Partial<ServerConfig> | null {
  const raw = mqtt?.url || mqtt?.tcpUrl;
  if (!raw) return null;
  const parsed = parseBrokerUrl(raw);
  if (!parsed) return null;
  return {
    mqttUrl: raw,
    mqttHost: parsed.host,
    mqttPort: parsed.port,
    mqttUseTls: mqtt.useTls ?? parsed.useTls,
    mqttUsername: mqtt.username ?? undefined,
    mqttPassword: mqtt.password ?? undefined,
    mqttSource: "bootstrap",
  };
}

function webSsoPatchFrom(webSso: BootstrapWebSsoPayload | undefined): Partial<ServerConfig> | null {
  if (!webSso?.loginUrl) return null;
  return {
    webSsoLoginUrl: webSso.loginUrl,
    webSsoStorageKey: webSso.storageKey ?? undefined,
  };
}

// Drop the per-account MQTT broker credentials so a different user doesn't
// inherit the previous user's session against the broker. Called from
// auth-store.signOut.
//
// The broker ADDRESS is deliberately kept: it is deployment topology, not
// account data, and it is the only copy the desktop has. Clearing it turned a
// sign-out into an outage whenever the Cloud API had stopped delivering an
// `mqtt` block — the next sign-in asks bootstrap once, gets nothing, and the
// app has no address left to fall back on (issue #634). What survives is
// re-labelled `cache` so the UI can say it is remembered rather than fresh.
//
// cloudApiUrl is not persisted (build config only). The Web SSO target is NOT
// cleared: it is non-sensitive public config and is needed on the login screen
// (pre-session), so wiping it on sign-out would hide 快捷登录 until the next fetch.
export async function clearBootstrapAppliedFields(): Promise<void> {
  const saved = await getSavedServerConfig();
  await saveServerConfig({
    ...saved,
    mqttUsername: undefined,
    mqttPassword: undefined,
    mqttSource: saved.mqttUrl || saved.mqttHost ? "cache" : undefined,
  });
}

// Fetch the PUBLIC (unauthenticated) config — the Web SSO 快捷登录 target and
// the login-method feature flags — and cache it. Unlike fetchAndApplyBootstrap
// this needs no session, so it can run before/at the login screen.
// Best-effort; never throws.
//
// This MUST run unconditionally at startup, not lazily behind a feature it
// itself configures: `features.auth` decides which sign-in buttons the login
// screen draws, so fetching it only once the user presses one of those buttons
// is circular.
export async function fetchPublicConfig(args?: { fetchImpl?: typeof fetch }): Promise<void> {
  const effective = await getEffectiveServerConfig();
  const baseUrl = effective.cloudApiUrl?.replace(/\/+$/, "");
  if (!baseUrl) return;
  const fetchImpl = args?.fetchImpl ?? fetch;
  let body: BootstrapPayload;
  try {
    const res = await fetchImpl(`${baseUrl}/v1/config/public${callerQuery()}`);
    if (!res.ok) return;
    body = (await res.json()) as BootstrapPayload;
  } catch {
    return;
  }
  // Applied even when absent: `applyRemoteFeatures` treats a missing block as
  // "no overrides", and recording that is how a flag the server has STOPPED
  // sending stops applying instead of living on in the cache forever.
  applyRemoteFeatures("public", body.features);
  const patch = webSsoPatchFrom(body.webSso);
  if (!patch) return;
  const saved = await getSavedServerConfig();
  await saveServerConfig({ ...saved, ...patch });
}

type CloudApiProbe =
  | { ok: true }
  /** Nothing answered: DNS failure, connection refused, TLS error, timeout. */
  | { ok: false; reason: "unreachable" }
  /** Something answered, but it is not a TeamClu Cloud API. */
  | { ok: false; reason: "not-cloud-api"; status?: number };

const PROBE_TIMEOUT_MS = 8000;

/**
 * Check that a URL is actually a reachable TeamClu Cloud API, before anything
 * is persisted against it.
 *
 * `/v1/config/public` is the right probe: it needs no session, it is the first
 * thing the app calls on every launch anyway, and a valid JSON object back is
 * evidence of a TeamClu Cloud API rather than merely *a* web server — a
 * mistyped host that happens to resolve (a parked domain, a proxy, a company
 * intranet page) answers 200 to `/healthz`-style probes and would pass a
 * liveness check while being useless to this app.
 *
 * Never throws; the failure modes are the return value.
 */
export async function probeCloudApi(
  url: string,
  args?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<CloudApiProbe> {
  const baseUrl = url.trim().replace(/\/+$/, "");
  if (!baseUrl) return { ok: false, reason: "unreachable" };
  const fetchImpl = args?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args?.timeoutMs ?? PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${baseUrl}/v1/config/public${callerQuery()}`, {
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reason: "not-cloud-api", status: res.status };
    const body = await res.json();
    // `{}` is a perfectly valid answer — it means "this deployment overrides
    // nothing". What it must not be is a string, an array, or null.
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { ok: false, reason: "not-cloud-api", status: res.status };
    }
    return { ok: true };
  } catch {
    // AbortError and network errors are indistinguishable to the user here, and
    // the remedy is the same: check the address, check the server is up.
    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What the last bootstrap attempt did to the MQTT broker config.
 *
 * `cloud-empty` is the one worth surfacing: the Cloud API answered 200 with no
 * `mqtt` block. It is not an error at the HTTP layer, which is exactly why it
 * went unnoticed for a day in issue #634 — callers must not treat it as success.
 */
type BootstrapMqttOutcome =
  | "applied" // cloud delivered a broker
  | "cloud-empty" // cloud answered, but without an mqtt block
  | "unreachable" // network/HTTP failure
  | "skipped"; // no token or no cloudApiUrl — nothing was attempted

// Bootstrap is best-effort: any failure leaves the existing client config in
// place. The function never throws so callers can fire-and-forget after sign-in.
export async function fetchAndApplyBootstrap(args: {
  accessToken: string | null | undefined;
  fetchImpl?: typeof fetch;
}): Promise<BootstrapMqttOutcome> {
  const token = args.accessToken?.trim();
  if (!token) return "skipped";
  const effective = await getEffectiveServerConfig();
  const baseUrl = effective.cloudApiUrl?.replace(/\/+$/, "");
  if (!baseUrl) return "skipped";
  const fetchImpl = args.fetchImpl ?? fetch;
  let body: BootstrapPayload;
  try {
    const res = await fetchImpl(`${baseUrl}/v1/config/bootstrap${callerQuery()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return "unreachable";
    body = (await res.json()) as BootstrapPayload;
  } catch {
    return "unreachable";
  }
  // Post-sign-in flags only; `auth` arriving here is ignored by design (it is
  // owned by /v1/config/public, which answers early enough to matter).
  applyRemoteFeatures("session", body.features);
  const mqttPatch = patchFromPayload(body.mqtt);
  const webSsoPatch = webSsoPatchFrom(body.webSso);
  const saved = await getSavedServerConfig();

  // No mqtt block: keep whatever address we already have and demote it to
  // `cache`, so the settings UI can flag "running on a remembered address"
  // instead of silently looking healthy.
  if (!mqttPatch) {
    const hasCached = Boolean(saved.mqttUrl || saved.mqttHost);
    if (webSsoPatch || hasCached) {
      await saveServerConfig({
        ...saved,
        ...webSsoPatch,
        ...(hasCached ? { mqttSource: "cache" as const } : {}),
      });
    }
    return "cloud-empty";
  }

  await saveServerConfig({ ...saved, ...mqttPatch, ...webSsoPatch });
  return "applied";
}
