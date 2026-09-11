// Runtime configuration delivered to clients on startup.
//
// Two endpoints, and every key belongs to exactly ONE of them:
//
//   /v1/config/public     (no auth)  — what the login screen needs before a
//                                      session exists: webSso, features.auth
//   /v1/config/bootstrap  (bearer)   — what only matters once signed in:
//                                      mqtt, features.{channels,…}
//
// features.auth cannot live in bootstrap: the login screen renders before any
// token exists, so a flag delivered there arrives too late to decide which
// sign-in buttons to draw.
//
// Responses are built from env + the in-repo feature profiles, never from the
// data backend.

import { FEATURE_PROFILES, type FeatureFlags } from "../feature-profiles.js";

function parseBool(raw) {
  if (raw == null) return undefined;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return undefined;
}

// Read an env var, treating blank as absent.
//
// Deployments declare optional vars with an empty default — `${env('X', '')}` in
// s.yaml, `"${X:-}"` in docker-compose — so "not configured" reaches the process
// as `""`, never as undefined. Any `??` chain over these therefore treats a
// blank as a real value; this helper is what makes "leave it empty" mean absent.
function envValue(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function buildMqttConfig() {
  // MQTT_BROKER_URL is the ONE broker address, and it is what clients receive.
  //
  // There is deliberately no public/internal split any more. The override that
  // used to sit in front of this (MQTT_PUBLIC_BROKER_URL) is gone: it defaulted
  // to `""` on both deploy targets, `""` is not nullish, so the documented
  // fallback never fired and bootstrap answered 200 with no `mqtt` block at all
  // — clients reported "the server did not deliver an MQTT address" while the
  // daemon, which never reads this endpoint, stayed connected and hid it.
  //
  // The cost of collapsing to one var: every deployment must set
  // MQTT_BROKER_URL to an address that is reachable BY CLIENTS, not just by FC.
  // A container-internal value (`mqtt://emqx:1883`, `mqtt://127.0.0.1:1883`)
  // is now a misconfiguration, because it is handed straight out.
  const url = envValue("MQTT_BROKER_URL");
  if (!url) return null;
  const mqtt: any = { url };
  // Optional raw-TCP address for clients whose MQTT stack can't do WebSocket
  // (rumqttc on desktop/daemon, CocoaMQTT on iOS). The all-in-one self-host
  // image multiplexes raw MQTT onto its single public port via Caddy layer4
  // and sets MQTT_PUBLIC_TCP_BROKER_URL accordingly.
  const tcpUrl = envValue("MQTT_PUBLIC_TCP_BROKER_URL");
  if (tcpUrl) mqtt.tcpUrl = tcpUrl;
  const useTls = parseBool(process.env.MQTT_USE_TLS);
  if (useTls !== undefined) mqtt.useTls = useTls;
  // Intentionally NOT forwarding MQTT_USERNAME/MQTT_PASSWORD to clients:
  // each client authenticates to EMQX with username=actor_id and
  // password=<Supabase access_token> (EMQX JWT auth, HS256). The static
  // MQTT_USERNAME/MQTT_PASSWORD env vars remain reserved for FC's own inbox
  // publisher (push-deps.ts), which connects to EMQX directly.
  return mqtt;
}

// Web SSO 快捷登录 target, delivered to clients so the admin console sign-in URL
// and supabase-js storage key are not hardcoded in the app. Env-driven like the
// MQTT block. storageKey is `sb-<supabase-ref>-auth-token` and can't be derived
// from the admin host, so it is its own variable.
function buildWebSsoConfig() {
  const loginUrl = envValue("WEBSSO_LOGIN_URL");
  if (!loginUrl) return null;
  const webSso: any = { loginUrl };
  const storageKey = envValue("WEBSSO_STORAGE_KEY");
  if (storageKey) webSso.storageKey = storageKey;
  return webSso;
}

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

// What a deployment is ALLOWED to override, hardcoded here rather than derived
// from whatever the profile/env happens to contain. Config decides the values;
// code decides the surface. An operator who writes `updater: false` into
// APP_FEATURES_JSON gets it dropped here — see the note on `updater` below.
const AUTH_KEYS = ["google", "wechat", "phone", "password", "webSSO"] as const;
const CHANNEL_KEYS = ["discord", "feishu", "email", "kook", "wecom", "wechat", "seatalk"] as const;
const BOOTSTRAP_BOOL_KEYS = ["apps", "lockLlmConfig", "allowNewOrg"] as const;

// `updater` is deliberately absent from every list above and must stay that
// way. It gates the startup auto-check as well as the About UI, so a wrong
// value here does not just hide a button — it strands every installed client
// with no way to update out of the mistake. It is a build-time flag only.

function pickBooleans(source: unknown, keys: readonly string[]): Record<string, boolean> | null {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const out: Record<string, boolean> = {};
  for (const key of keys) {
    const value = (source as Record<string, unknown>)[key];
    // Anything non-boolean is dropped rather than coerced: a stray "false"
    // string would otherwise enable the feature it was meant to disable.
    if (typeof value === "boolean") out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

/** Drop everything not on the allowlist, and everything not a boolean. */
function sanitizeFeatures(raw: unknown): FeatureFlags {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const out: FeatureFlags = {};
  const auth = pickBooleans(source.auth, AUTH_KEYS);
  if (auth) out.auth = auth;
  const channels = pickBooleans(source.channels, CHANNEL_KEYS);
  if (channels) out.channels = channels;
  for (const key of BOOTSTRAP_BOOL_KEYS) {
    if (typeof source[key] === "boolean") out[key] = source[key] as boolean;
  }
  return out;
}

/**
 * Key-by-key, one level deep — NOT a block replacement. An emergency
 * `APP_FEATURES_JSON={"auth":{"google":false}}` must turn off exactly Google,
 * not silently wipe every other flag the profile sets.
 */
function mergeFeatures(base: FeatureFlags, override: FeatureFlags): FeatureFlags {
  const merged: FeatureFlags = { ...base, ...override };
  if (base.auth || override.auth) merged.auth = { ...base.auth, ...override.auth };
  if (base.channels || override.channels) {
    merged.channels = { ...base.channels, ...override.channels };
  }
  return merged;
}

// Cached per distinct (profile, json) pair. This both avoids re-parsing on
// every request and makes the warnings below fire once per bad value rather
// than once per request — while still re-resolving when the env actually
// changes, which is what the tests do.
const featureCache = new Map<string, FeatureFlags>();

export function resolveFeatures(env: NodeJS.ProcessEnv = process.env): FeatureFlags {
  const profileName = envValue("APP_FEATURES_PROFILE", env);
  const rawJson = envValue("APP_FEATURES_JSON", env);
  // NUL joins the two halves because it is the one byte neither env var can
  // contain, so no (profile, json) pair can collide with another by splitting
  // differently. Written as an escape rather than as a raw byte: a literal NUL
  // here made git classify this whole file as binary — no textual diffs on it,
  // and `grep` silently matching nothing.
  const cacheKey = `${profileName ?? ""}\u0000${rawJson ?? ""}`;
  const cached = featureCache.get(cacheKey);
  if (cached) return cached;

  let base: FeatureFlags = {};
  if (profileName) {
    const profile = FEATURE_PROFILES[profileName];
    if (profile) {
      base = sanitizeFeatures(profile);
    } else {
      // A typo in the profile name must not take the deployment down: config
      // is not worth a 500. Degrade to "no overrides" and say so loudly.
      console.warn(
        `[config] unknown APP_FEATURES_PROFILE=${profileName}; known: ${Object.keys(FEATURE_PROFILES).join(", ")}`,
      );
    }
  }

  let override: FeatureFlags = {};
  if (rawJson) {
    try {
      override = sanitizeFeatures(JSON.parse(rawJson));
    } catch {
      console.warn("[config] APP_FEATURES_JSON is not valid JSON; ignoring it");
    }
  }

  const resolved = mergeFeatures(base, override);
  featureCache.set(cacheKey, resolved);
  // Absent/empty is a normal state, but it is indistinguishable at the client
  // from "the profile never made it into the package" — so make the difference
  // visible in the logs at least once.
  console.log(
    `[config] features profile=${profileName ?? "<none>"} override=${rawJson ? "yes" : "no"} keys=${Object.keys(resolved).length}`,
  );
  return resolved;
}

/** Login-screen flags. Public endpoint only — bootstrap runs too late. */
function buildPublicFeatures() {
  const { auth } = resolveFeatures();
  return auth && Object.keys(auth).length ? { auth } : null;
}

/** Post-sign-in flags. UI gating only — never a substitute for server-side authorization. */
function buildBootstrapFeatures() {
  const features = resolveFeatures();
  const out: FeatureFlags = {};
  if (features.channels && Object.keys(features.channels).length) out.channels = features.channels;
  for (const key of BOOTSTRAP_BOOL_KEYS) {
    if (typeof features[key] === "boolean") out[key] = features[key];
  }
  return Object.keys(out).length ? out : null;
}

export function buildBootstrapConfig() {
  const config: any = {};
  const mqtt = buildMqttConfig();
  if (mqtt) config.mqtt = mqtt;
  // DEPRECATED here, and kept only for shipped clients: builds older than the
  // public-config fetch resolve their 快捷登录 target from this block, so
  // dropping it would break their sign-in until they update. New clients read
  // it from /v1/config/public.
  const webSso = buildWebSsoConfig();
  if (webSso) config.webSso = webSso;
  const features = buildBootstrapFeatures();
  if (features) config.features = features;
  return config;
}

// Non-sensitive config that clients need BEFORE they have a session — currently
// just the Web SSO 快捷登录 target, which is a login method (the authed bootstrap
// above runs only post-sign-in, too late for the login screen). No bearer; never
// includes the MQTT broker credentials.
export function buildPublicConfig() {
  const config: any = {};
  const webSso = buildWebSsoConfig();
  if (webSso) config.webSso = webSso;
  const features = buildPublicFeatures();
  if (features) config.features = features;
  return config;
}

// brand/platform/version are accepted and logged but do not change the answer
// yet. They exist so a per-brand or version-gated rollout is a server-side
// change later, instead of a client release to start sending them.
function logCaller(ctx: any, endpoint: string) {
  const brand = ctx?.query?.get?.("brand");
  if (!brand) return;
  const platform = ctx?.query?.get?.("platform") ?? "?";
  const version = ctx?.query?.get?.("version") ?? "?";
  console.log(`[config] ${endpoint} brand=${brand} platform=${platform} version=${version}`);
}

export function registerConfig(router) {
  router.get("/v1/config/bootstrap", async (ctx) => {
    logCaller(ctx, "bootstrap");
    return { body: buildBootstrapConfig() };
  });
  router.get("/v1/config/public", { auth: "none" }, async (ctx) => {
    logCaller(ctx, "public");
    return { body: buildPublicConfig() };
  });
}
