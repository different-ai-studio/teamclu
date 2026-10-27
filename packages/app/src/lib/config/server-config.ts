import type { BackendKind } from "@/lib/backend/types";
import { buildConfig } from "@/lib/config/build-config";

export interface ServerConfig {
  backendKind?: BackendKind;
  cloudApiUrl?: string;
  /** Full MQTT endpoint, including the scheme and optional WebSocket path. */
  mqttUrl?: string;
  mqttHost?: string;
  mqttPort?: number;
  mqttUseTls?: boolean;
  mqttUsername?: string;
  mqttPassword?: string;
  /**
   * Where the broker address above came from, so the UI can distinguish "the
   * cloud just told us this" from "we are running on a remembered address the
   * cloud has stopped handing out". `undefined` on configs written before this
   * field existed, and on build-config/env defaults.
   *
   * - `bootstrap` — the last `/v1/config/bootstrap` returned an `mqtt` block
   * - `cache` — bootstrap answered without one; this is a last-known address
   */
  mqttSource?: "bootstrap" | "cache";
  // Web SSO 快捷登录 target, delivered by /v1/config/bootstrap (like MQTT) so
  // the admin console sign-in URL + supabase-js storage key are not hardcoded.
  webSsoLoginUrl?: string;
  webSsoStorageKey?: string;
}

// The Cloud API URL normally comes from the frontend build config
// (`build.config*.json` → `buildConfig.cloudApiUrl`) or the `VITE_CLOUD_API_URL`
// env var at build/dev time.
//
// This localStorage entry is a session cache for the MQTT broker config that the
// Cloud API delivers via `/v1/config/bootstrap` after sign-in — nothing else. It
// lets the MQTT client read a broker synchronously before bootstrap re-runs. It
// never carries a cloudApiUrl: the legacy `~/.teamclu/config.json` override
// (and the `window.__TEAMCLU_SERVER_CONFIG__` injection that carried it) were
// removed because a value riding along in this cache could silently shadow the
// baked build config.
const STORAGE_KEY = "teamclu.serverConfig";

// A user-chosen Cloud API URL lives under its own key, separate from the cache
// above, and wins over both the env var and the build config. It is written only
// by an explicit user action (the "Custom server" entry in onboarding), and every
// surface that shows the effective URL also offers a reset — so an override is
// always visible as an override rather than shadowing the build config silently.
const CLOUD_API_OVERRIDE_KEY = "teamclu.cloudApiUrl.override";

function readLocalConfig(): ServerConfig {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as ServerConfig;
  } catch {
    return {};
  }
}

function writeLocalConfig(config: ServerConfig) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

/** Trims trailing slashes and rejects anything that isn't an http(s) URL. */
export function normalizeCloudApiUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return trimmed;
}

/**
 * A Cloud API URL as the UI prints it: no scheme, no trailing slash. Lives here
 * next to `normalizeCloudApiUrl` because both onboarding footers and the
 * server-entry row have to agree on what "the address" looks like.
 */
export function displayHost(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

// Broadcast whenever the effective Cloud API URL changes. Anything keyed by
// backend identity (the remote feature snapshots, today) listens for it.
//
// The "Custom server" flow reloads the window immediately after writing the
// override, so listeners would be re-seeded by module load anyway — but that is
// a property of one caller, not a guarantee. An in-place server switch added
// later would otherwise leave per-origin caches pointing at the old backend,
// and nothing would fail loudly enough to notice.
//
// A DOM event rather than an exported subscribe(): a direct import would put
// this module in the import graph of every listener, and any suite that
// partially mocks @/lib/config/server-config would then fail to import them at all.
// Listeners hardcode the same literal — see lib/remote-features.ts.
export const CLOUD_API_URL_CHANGED_EVENT = "teamclu:cloud-api-url-changed";

/** The user-chosen Cloud API URL, or null when none is set. */
export function getCloudApiUrlOverride(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CLOUD_API_OVERRIDE_KEY);
    return raw ? normalizeCloudApiUrl(raw) : null;
  } catch {
    return null;
  }
}

/** The build-config/env URL, ignoring any override — what a reset returns to. */
export function getDefaultCloudApiUrl(): string | undefined {
  return import.meta.env.VITE_CLOUD_API_URL || buildConfig.cloudApiUrl;
}

/**
 * Persists a user-chosen Cloud API URL, or clears it when passed null.
 * Returns the normalized value that was stored. Throws on an unparseable URL so
 * callers surface the error rather than silently keeping the old backend.
 *
 * The caller is responsible for signing out and reloading: an access token from
 * the previous backend is not valid against the new one.
 */
export function setCloudApiUrlOverride(raw: string | null): string | null {
  if (typeof window === "undefined") return null;
  if (raw === null) {
    window.localStorage.removeItem(CLOUD_API_OVERRIDE_KEY);
    notifyCloudApiUrlChanged(null);
    return null;
  }
  const normalized = normalizeCloudApiUrl(raw);
  if (!normalized) throw new Error(`Not a valid http(s) URL: ${raw}`);
  window.localStorage.setItem(CLOUD_API_OVERRIDE_KEY, normalized);
  notifyCloudApiUrlChanged(normalized);
  return normalized;
}

/**
 * Drop the bootstrap cache (broker address, credentials, Web SSO target).
 *
 * Ordinary sign-out keeps the broker address: it is deployment topology, and
 * wiping it stranded clients when bootstrap later omitted `mqtt` (#634).
 * Switching Cloud API is the opposite case — that cache belongs to the
 * deployment being left, and the next bootstrap must be the only source.
 */
export function clearCachedBootstrapConfig(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}

function notifyCloudApiUrlChanged(url: string | null): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(CLOUD_API_URL_CHANGED_EVENT, { detail: url }));
  } catch (error) {
    // The override is already written; a failed notification must not abort
    // the switch itself.
    console.warn("[server-config] cloud API url change notification failed:", error);
  }
}

/**
 * Parses VITE_MQTT_WS_URL (a full ws/wss URL) into host/port/useTls overrides.
 * Returns undefined when the env var is absent or unparseable.
 */
function parseMqttWsUrlOverride():
  | { mqttUrl: string; mqttHost: string; mqttPort: number | undefined; mqttUseTls: boolean }
  | undefined {
  const raw = import.meta.env.VITE_MQTT_WS_URL;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const isTls = url.protocol === "wss:";
    return {
      mqttUrl: raw,
      mqttHost: url.hostname,
      // When the URL omits the port (e.g. wss://host/mqtt behind a 443 reverse
      // proxy) fall back to the scheme default rather than undefined — otherwise
      // the override leaves the port unset and the bridge defaults it to the
      // TCP broker port (1883), producing an unreachable wss://host:1883/mqtt.
      mqttPort: url.port ? Number(url.port) : isTls ? 443 : 80,
      mqttUseTls: isTls,
    };
  } catch {
    return undefined;
  }
}

function envConfig(): ServerConfig {
  const mqttPort = Number(import.meta.env.VITE_MQTT_PORT ?? "");
  const rawUseTls = import.meta.env.VITE_MQTT_USE_TLS?.trim().toLowerCase();
  const mqttUseTls =
    rawUseTls === "true" || rawUseTls === "1"
      ? true
      : rawUseTls === "false" || rawUseTls === "0"
        ? false
        : undefined;
  return {
    backendKind: "cloud_api",
    // Env var wins; otherwise fall back to the value baked into build.config.*.
    cloudApiUrl: getDefaultCloudApiUrl(),
    mqttUrl: import.meta.env.VITE_MQTT_URL,
    mqttHost: import.meta.env.VITE_MQTT_HOST,
    mqttPort: Number.isFinite(mqttPort) ? mqttPort : undefined,
    mqttUseTls,
    mqttUsername: import.meta.env.VITE_MQTT_USERNAME,
    mqttPassword: import.meta.env.VITE_MQTT_PASSWORD,
    webSsoLoginUrl: import.meta.env.VITE_WEBSSO_LOGIN_URL,
    webSsoStorageKey: import.meta.env.VITE_WEBSSO_STORAGE_KEY,
  };
}

// Only the bootstrap-delivered config (MQTT broker + Web SSO target) is
// persisted. cloudApiUrl and backendKind are intentionally dropped — they are
// never a runtime override.
function normalizeCachedConfig(config: ServerConfig): ServerConfig {
  return {
    mqttUrl: config.mqttUrl?.trim() || undefined,
    mqttHost: config.mqttHost?.trim() || undefined,
    mqttPort: config.mqttPort,
    mqttUseTls: config.mqttUseTls,
    mqttUsername: config.mqttUsername?.trim() || undefined,
    mqttPassword: config.mqttPassword?.trim() || undefined,
    webSsoLoginUrl: config.webSsoLoginUrl?.trim() || undefined,
    webSsoStorageKey: config.webSsoStorageKey?.trim() || undefined,
  };
}

function hasOwn(config: ServerConfig, key: keyof ServerConfig): boolean {
  return Object.prototype.hasOwnProperty.call(config, key);
}

function resolve(rawSaved: ServerConfig): ServerConfig {
  const saved = normalizeCachedConfig(rawSaved);
  const env = envConfig();
  const cloudOverride = getCloudApiUrlOverride();
  // A custom Cloud API is another deployment. The MQTT URL and Web SSO target
  // baked into this build belong to the official one; letting them win after
  // the API has moved leaves realtime on a broker that does not know the user
  // (`transport_offline`). Until that deployment's bootstrap lands, an empty
  // broker is the safe state. With no override, VITE_MQTT_WS_URL still wins
  // over both bootstrap and env for host/port/tls, and credentials still come
  // from bootstrap.
  const wsOverride = cloudOverride ? undefined : parseMqttWsUrlOverride();
  const bakedTransport = !cloudOverride;
  return {
    backendKind: "cloud_api",
    // An explicit user override wins over the build config; otherwise the build
    // config (or its env var) is the source of truth. The `saved` bootstrap
    // cache never contributes a cloudApiUrl — only CLOUD_API_OVERRIDE_KEY does.
    cloudApiUrl: cloudOverride ?? env.cloudApiUrl,
    mqttUrl: wsOverride?.mqttUrl ?? saved.mqttUrl ?? (bakedTransport ? env.mqttUrl : undefined),
    mqttHost: wsOverride
      ? wsOverride.mqttHost
      : (saved.mqttHost ?? (bakedTransport ? env.mqttHost : undefined)),
    mqttPort: wsOverride
      ? wsOverride.mqttPort
      : (saved.mqttPort ?? (bakedTransport ? env.mqttPort : undefined)),
    mqttUseTls: wsOverride
      ? wsOverride.mqttUseTls
      : (saved.mqttUseTls ?? (bakedTransport ? env.mqttUseTls : undefined)),
    mqttUsername: hasOwn(rawSaved, "mqttUsername")
      ? saved.mqttUsername
      : bakedTransport
        ? env.mqttUsername
        : undefined,
    mqttPassword: hasOwn(rawSaved, "mqttPassword")
      ? saved.mqttPassword
      : bakedTransport
        ? env.mqttPassword
        : undefined,
    // Web SSO target: bootstrap cache wins, dev env var as fallback — unless
    // the Cloud API itself has been pointed elsewhere, in which case the env
    // target is the official deployment's and must not leak across.
    webSsoLoginUrl: saved.webSsoLoginUrl ?? (bakedTransport ? env.webSsoLoginUrl : undefined),
    webSsoStorageKey: saved.webSsoStorageKey ?? (bakedTransport ? env.webSsoStorageKey : undefined),
  };
}

export function getEffectiveServerConfigSync(): ServerConfig {
  return resolve(readLocalConfig());
}

export async function getSavedServerConfig(): Promise<ServerConfig> {
  return readLocalConfig();
}

export async function saveServerConfig(config: ServerConfig): Promise<ServerConfig> {
  const normalized = normalizeCachedConfig(config);
  writeLocalConfig(normalized);
  return { backendKind: "cloud_api", ...normalized };
}

export async function getEffectiveServerConfig(): Promise<ServerConfig> {
  return resolve(readLocalConfig());
}
