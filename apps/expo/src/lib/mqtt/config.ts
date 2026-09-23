import AsyncStorage from "@react-native-async-storage/async-storage";
import { cloudApiBaseUrl, createCloudApiClient } from "../cloud-api/client";

// The broker address is env-driven server-side and delivered by
// `GET /v1/config/bootstrap`, not baked into the bundle: a broker that moves
// must not require an app release. The last address is cached so a cold or
// offline launch can still connect.
//
// The same answer carries the post-sign-in feature flags (`features`), which
// ride along here rather than costing a second request for a document this
// module already fetches on every launch — as iOS `ServerBrokerConfig
// .fetchBootstrap` does. They are cached the same way.

const CACHE_KEY = "teamclu.mqtt.broker-url";
const FEATURES_CACHE_KEY = "teamclu.bootstrap.features";

type StorageLike = Pick<typeof AsyncStorage, "getItem" | "setItem" | "removeItem">;

type BootstrapConfig = {
  mqtt?: { url?: string; tcpUrl?: string } | null;
  features?: { apps?: boolean | null } | null;
};

/**
 * Post-sign-in feature flags from `GET /v1/config/bootstrap` (`features`).
 * UI gating only — the server authorizes every call regardless.
 */
export type BootstrapFeatureFlags = {
  /** The team-apps surface: the drawer entry and the pages behind it. */
  apps: boolean;
};

/**
 * What the client assumes before the server answers, and when it never does.
 * Apps is on for every deployment that configures a profile except
 * copilot361, so failing open matches the common case (iOS
 * `BootstrapFeatureFlags.failOpen`).
 */
export const FAIL_OPEN_FEATURE_FLAGS: BootstrapFeatureFlags = Object.freeze({ apps: true });

let lastResolvedUrl: string | null = null;
let lastFeatureFlags: BootstrapFeatureFlags | null = null;
const featureListeners = new Set<() => void>();

/**
 * Read the `features` block. Null when the block is absent entirely: FC omits
 * it when the deployment configures no feature profile, and that means "keep
 * the client's defaults", not "turn everything off". Within a present block a
 * missing key IS off — the deployment's explicit choice.
 */
export function parseBootstrapFeatures(config: unknown): BootstrapFeatureFlags | null {
  if (!config || typeof config !== "object") return null;
  const features = (config as BootstrapConfig).features;
  if (!features || typeof features !== "object") return null;
  return { apps: features.apps === true };
}

function setFeatureFlags(next: BootstrapFeatureFlags | null) {
  const prev = lastFeatureFlags;
  if (prev?.apps === next?.apps && (prev === null) === (next === null)) return;
  lastFeatureFlags = next;
  for (const listener of featureListeners) listener();
}

/**
 * The flags in effect now: the last answer (fetched or cached) or, before
 * any, the fail-open defaults. Returns a stable reference between changes so
 * it can back `useSyncExternalStore`.
 */
export function getKnownFeatureFlags(): BootstrapFeatureFlags {
  return lastFeatureFlags ?? FAIL_OPEN_FEATURE_FLAGS;
}

/** Subscribe to flag changes; returns the unsubscribe function. */
export function subscribeFeatureFlags(listener: () => void): () => void {
  featureListeners.add(listener);
  return () => {
    featureListeners.delete(listener);
  };
}

/** Last flags handed out by the Cloud API, or null if never fetched. */
export async function getCachedFeatureFlags(
  storage: StorageLike = AsyncStorage,
): Promise<BootstrapFeatureFlags | null> {
  try {
    const raw = await storage.getItem(FEATURES_CACHE_KEY);
    if (!raw) return null;
    return parseBootstrapFeatures({ features: JSON.parse(raw) });
  } catch {
    return null;
  }
}

async function hydrateFeatureFlagsFromCache(storage: StorageLike): Promise<void> {
  if (lastFeatureFlags) return;
  const cached = await getCachedFeatureFlags(storage);
  if (cached) setFeatureFlags(cached);
}

/** An explicit build-time override always wins (local dev against a test broker). */
export function getMqttUrlOverride(): string | null {
  const url = process.env.EXPO_PUBLIC_MQTT_URL?.trim();
  return url && url.length > 0 ? url : null;
}

/**
 * The address most recently resolved in this process, for UI and controllers
 * that need it synchronously. Null until the first `resolveMqttUrl` — which the
 * root layout runs before it connects, so screens downstream of a live
 * connection always see an address.
 */
export function getKnownMqttUrl(): string | null {
  return getMqttUrlOverride() ?? lastResolvedUrl;
}

/** Last broker address handed out by the Cloud API, or null if never fetched. */
export async function getCachedMqttUrl(
  storage: StorageLike = AsyncStorage,
): Promise<string | null> {
  const cached = (await storage.getItem(CACHE_KEY))?.trim();
  return cached && cached.length > 0 ? cached : null;
}

/**
 * Forget the cached broker. Called on sign-out.
 *
 * The cache exists so a cold or offline launch can still connect, but it
 * outlives the account it was fetched for. Sign out of one deployment and into
 * another on the same device and the fallback would hand the new session the
 * old deployment's broker — which it would then dial with the new user's token,
 * failing in a way that looks like a broker outage rather than stale config.
 *
 * Best-effort: a storage error here must not block sign-out, and the in-process
 * value is dropped either way, so the next resolve starts from the API.
 */
export async function clearCachedMqttUrl(
  storage: StorageLike = AsyncStorage,
): Promise<void> {
  lastResolvedUrl = null;
  // Flags are per deployment for the same reason the broker is.
  setFeatureFlags(null);
  try {
    await storage.removeItem(CACHE_KEY);
    await storage.removeItem(FEATURES_CACHE_KEY);
  } catch {
    // Nothing actionable — the in-process value is already cleared.
  }
}

/**
 * Resolve the broker address: build-time override → Cloud API → cached address
 * from the last successful fetch. Returns null when none of the three yields an
 * address, in which case the caller simply does not connect — there is no
 * bundled host to fall back on, because an address baked into a release
 * outlives the server it points at.
 *
 * Side effect: applies the bootstrap `features` block (see
 * `getKnownFeatureFlags`). With the build-time broker override set, no request
 * is made, so flags come from the cache or stay at their fail-open defaults.
 */
export async function resolveMqttUrl(args: {
  getAccessToken: () => Promise<string | null>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  storage?: StorageLike;
}): Promise<string | null> {
  const override = getMqttUrlOverride();
  const storage = args.storage ?? AsyncStorage;
  if (override) {
    await hydrateFeatureFlagsFromCache(storage);
    return override;
  }

  try {
    const client = createCloudApiClient({
      baseUrl: args.baseUrl ?? cloudApiBaseUrl(),
      getAccessToken: args.getAccessToken,
      fetchImpl: args.fetchImpl,
    });
    const config = await client.get<BootstrapConfig>("/v1/config/bootstrap");
    // Flags first: they land even when this deployment ships no broker block
    // and the url branch below falls through.
    const features = parseBootstrapFeatures(config);
    if (features) {
      setFeatureFlags(features);
      try {
        await storage.setItem(FEATURES_CACHE_KEY, JSON.stringify(features));
      } catch {
        // The in-process value is already applied; the cache is best-effort.
      }
    } else {
      await hydrateFeatureFlagsFromCache(storage);
    }
    // `tcpUrl` first: the native MQTT client dials the raw broker, while `url`
    // may be the WebSocket address meant for browsers.
    const url = (config.mqtt?.tcpUrl ?? config.mqtt?.url)?.trim();
    if (url) {
      await storage.setItem(CACHE_KEY, url);
      lastResolvedUrl = url;
      return url;
    }
  } catch {
    // Offline, unauthenticated, or the endpoint is unavailable — fall through
    // to whatever the last successful fetch cached.
    await hydrateFeatureFlagsFromCache(storage);
  }
  const cached = await getCachedMqttUrl(storage);
  if (cached) lastResolvedUrl = cached;
  return cached;
}
