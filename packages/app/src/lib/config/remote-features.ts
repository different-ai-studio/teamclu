// Runtime feature flags: the Cloud API is the ONLY source.
//
// Flags used to live in `buildConfig.features` as well, so every change meant
// shipping a new client AND remembering to restate it server-side — two copies
// that drifted. The build config no longer carries them: a flag is now edited
// in exactly one place, `services/fc/src/lib/feature-profiles.ts`.
//
// `updater` is the single exception and is NOT a feature flag in this sense —
// see the note where it is resolved below.
//
// Nothing here requires the network. With no snapshot and no reachable server
// every flag falls back to OFF, leaving email OTP — the one method that needs
// no flag — as the way in. A brand whose real login method is something else
// therefore shows a reduced login screen until the first `/v1/config/public`
// lands, which is the deliberate cost of having one source of truth.
//
// Two snapshots, two scopes, because the two endpoints answer at different
// times in the app's life:
//
//   public  — /v1/config/public, fetched at startup with no session. The login
//             screen needs `auth.*` before any token exists.
//   session — /v1/config/bootstrap, fetched after sign-in.
//
// Sign-out clears only the session snapshot. The public one is deployment-level
// config, not account data: wiping it would send the next launch's login screen
// back to the baked defaults with no way to know better until a fetch lands —
// the same shape of regression as clearing the MQTT address on sign-out (#634).

import { useSyncExternalStore } from "react";

import { buildConfig, type ChannelsFeatureConfig } from "@/lib/config/build-config";
import { getCloudApiUrlOverride, getDefaultCloudApiUrl } from "@/lib/config/server-config";

type FeatureScope = "public" | "session";

interface AuthFeatures {
  google: boolean;
  wechat: boolean;
  phone: boolean;
  password: boolean;
  webSSO: boolean;
}

interface ResolvedFeatures {
  /** Build-time only, never remote — see the note on the allowlists below. */
  updater: boolean;
  auth: AuthFeatures;
  channels: ChannelsFeatureConfig;
  apps: boolean;
  lockLlmConfig: boolean;
}

// What the server is allowed to influence, restated on the client. The server
// has its own allowlist; this is not redundancy but the half we control — a
// compromised or simply misconfigured deployment must not be able to introduce
// a flag the client never agreed to honour.
//
// `updater` is on neither list, deliberately. It gates the startup auto-check
// as well as the UI, so a remote `false` would strand the fleet with no way to
// update out of it. It stays build-time.
const AUTH_KEYS = ["google", "wechat", "phone", "password", "webSSO"] as const;
const CHANNEL_KEYS = ["discord", "feishu", "email", "kook", "wecom", "wechat"] as const;
const BOOL_KEYS = ["apps", "lockLlmConfig"] as const;

interface RemoteFeaturePatch {
  auth?: Partial<AuthFeatures>;
  channels?: Partial<ChannelsFeatureConfig>;
  apps?: boolean;
  lockLlmConfig?: boolean;
}

function pickBooleans<K extends string>(
  source: unknown,
  keys: readonly K[],
): Partial<Record<K, boolean>> | undefined {
  if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
  const out: Partial<Record<K, boolean>> = {};
  for (const key of keys) {
    const value = (source as Record<string, unknown>)[key];
    // Non-booleans are dropped rather than coerced: a "false" string would
    // otherwise switch on the very thing it was written to switch off.
    if (typeof value === "boolean") out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Keep only known keys with the right types. Anything else is discarded. */
export function sanitizeRemoteFeatures(raw: unknown): RemoteFeaturePatch {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const patch: RemoteFeaturePatch = {};
  const auth = pickBooleans(source.auth, AUTH_KEYS);
  if (auth) patch.auth = auth;
  const channels = pickBooleans(source.channels, CHANNEL_KEYS);
  if (channels) patch.channels = channels;
  for (const key of BOOL_KEYS) {
    if (typeof source[key] === "boolean") patch[key] = source[key] as boolean;
  }
  return patch;
}

/**
 * Every key has exactly ONE authoritative endpoint, and this is where the
 * client enforces it: `auth` is public-scope only, everything else is
 * session-scope only.
 *
 * Without this, the same flag could arrive from both endpoints and the winner
 * would be whichever fetch happened to land last — a race that would show up as
 * a flag that "sometimes" applies. Dropping the out-of-scope keys makes the
 * ownership rule structural rather than a convention the server has to honour.
 */
function scopeToOwnedKeys(scope: FeatureScope, patch: RemoteFeaturePatch): RemoteFeaturePatch {
  if (scope === "public") return patch.auth ? { auth: patch.auth } : {};
  const { auth: _ignored, ...rest } = patch;
  return rest;
}

// ---------------------------------------------------------------------------
// Snapshot storage
// ---------------------------------------------------------------------------

// Partitioned by Cloud API origin. Pointing the app at a different server must
// not inherit the previous server's flags — and because the key changes with
// the origin, that falls out of the key rather than needing an explicit
// invalidation step that could be forgotten.
function storageKey(scope: FeatureScope, origin: string): string {
  return `teamclu.remoteFeatures.${scope}:${origin}`;
}

/** Origin of the Cloud API this app is currently pointed at, or "" when none. */
function currentCloudApiOrigin(): string {
  try {
    const url = getCloudApiUrlOverride() ?? getDefaultCloudApiUrl();
    return url ? new URL(url).origin : "";
  } catch {
    // An unparseable URL, or a partially mocked server-config module under
    // test. Either way: no origin, so no snapshot — the build config stands.
    return "";
  }
}

function readSnapshot(scope: FeatureScope, origin: string): RemoteFeaturePatch {
  if (typeof window === "undefined" || !origin) return {};
  try {
    const raw = window.localStorage.getItem(storageKey(scope, origin));
    if (!raw) return {};
    // Sanitize on read too, not just on write: a snapshot written by an older
    // build (or hand-edited) must not be able to smuggle in a retired key.
    return sanitizeRemoteFeatures(JSON.parse(raw));
  } catch {
    return {};
  }
}

function writeSnapshot(scope: FeatureScope, origin: string, patch: RemoteFeaturePatch): void {
  if (typeof window === "undefined" || !origin) return;
  try {
    window.localStorage.setItem(storageKey(scope, origin), JSON.stringify(patch));
  } catch {
    // A full/blocked localStorage must not break feature resolution — the
    // in-memory value below still applies for this session.
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function resolveFrom(patches: RemoteFeaturePatch[]): ResolvedFeatures {
  const merged: RemoteFeaturePatch = {};
  for (const patch of patches) {
    Object.assign(merged, patch, {
      auth: { ...merged.auth, ...patch.auth },
      channels: { ...merged.channels, ...patch.channels },
    });
  }

  return {
    // The one flag that is still build-time, and deliberately so: it gates the
    // startup auto-check as well as the About button, so a wrong remote value
    // would not hide a button — it would strand every installed client with no
    // way to update out of the mistake. Defaults to on: an absent flag must not
    // silently disable updates.
    updater: buildConfig?.features?.updater ?? true,
    auth: {
      google: merged.auth?.google ?? false,
      wechat: merged.auth?.wechat ?? false,
      phone: merged.auth?.phone ?? false,
      password: merged.auth?.password ?? false,
      // Server-controlled like every other flag. Where the flow may point is
      // server-controlled too (WEBSSO_LOGIN_URL) — there is no build-time host
      // list any more.
      webSSO: merged.auth?.webSSO ?? false,
    },
    channels: {
      discord: merged.channels?.discord ?? false,
      feishu: merged.channels?.feishu ?? false,
      email: merged.channels?.email ?? false,
      kook: merged.channels?.kook ?? false,
      wecom: merged.channels?.wecom ?? false,
      wechat: merged.channels?.wechat ?? false,
      seatalk: merged.channels?.seatalk ?? false,
    },
    apps: merged.apps ?? false,
    lockLlmConfig: merged.lockLlmConfig ?? false,
  };
}

// In-memory mirror of the two snapshots, seeded synchronously at module load so
// the very first paint (the login screen) already has the last known answer.
let originAtLoad = currentCloudApiOrigin();
const patches: Record<FeatureScope, RemoteFeaturePatch> = {
  public: readSnapshot("public", originAtLoad),
  session: readSnapshot("session", originAtLoad),
};

type Listener = (features: ResolvedFeatures) => void;
const listeners = new Set<Listener>();
let resolved: ResolvedFeatures = resolveFrom([patches.public, patches.session]);

function recompute(): void {
  const next = resolveFrom([patches.public, patches.session]);
  // Cheap structural compare: this runs on every fetch, and re-rendering the
  // whole feature-gated UI because the server repeated itself is pure churn.
  if (JSON.stringify(next) === JSON.stringify(resolved)) return;
  resolved = next;
  for (const listener of listeners) listener(resolved);
}

/** Current effective flags. Safe to call before any fetch has completed. */
export function getFeatures(): ResolvedFeatures {
  return resolved;
}

export function subscribeFeatures(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Store a `features` block delivered by the Cloud API. Unknown/ill-typed keys
 * are dropped; an absent or empty block is a no-op rather than "disable
 * everything" — the server answering `{}` means "no overrides", and reading it
 * as "all off" is exactly how #634 turned a quiet server into an outage.
 */
export function applyRemoteFeatures(scope: FeatureScope, raw: unknown): void {
  const patch = scopeToOwnedKeys(scope, sanitizeRemoteFeatures(raw));
  const origin = currentCloudApiOrigin();
  patches[scope] = patch;
  writeSnapshot(scope, origin, patch);
  recompute();
}

/**
 * Drop the post-sign-in snapshot. Called from auth-store.signOut alongside the
 * other per-account state. The public snapshot deliberately survives.
 */
export function clearSessionFeatures(): void {
  patches.session = {};
  const origin = currentCloudApiOrigin();
  if (typeof window !== "undefined" && origin) {
    try {
      window.localStorage.removeItem(storageKey("session", origin));
    } catch {
      /* ignore */
    }
  }
  recompute();
}

/**
 * Re-seed from storage for the current origin. Called when the Cloud API URL
 * changes.
 *
 * Today the "Custom server" flow reloads the whole window right after writing
 * the override, so module load would re-seed anyway — but that is a property of
 * one caller, not a guarantee. Wiring this to the change notification keeps the
 * behaviour correct if an in-place server switch is ever added.
 */
function reloadFeaturesForCurrentOrigin(): void {
  originAtLoad = currentCloudApiOrigin();
  patches.public = readSnapshot("public", originAtLoad);
  patches.session = readSnapshot("session", originAtLoad);
  recompute();
}

// Switching backends re-seeds from that backend's own snapshots. Today the
// "Custom server" flow reloads the window immediately afterwards, which would
// do the same thing — this makes it hold even if that ever stops being true.
//
// The event name is duplicated from CLOUD_API_URL_CHANGED_EVENT in
// lib/server-config rather than imported: importing a const from a module that
// suites partially mock makes THIS module unimportable in those suites, which
// is a worse coupling than one repeated string literal.
if (typeof window !== "undefined") {
  window.addEventListener("teamclu:cloud-api-url-changed", () =>
    reloadFeaturesForCurrentOrigin(),
  );
}

/** Test seam: forget everything in memory and re-read storage. */
export function __resetFeaturesForTest(): void {
  reloadFeaturesForCurrentOrigin();
}

// ---------------------------------------------------------------------------
// React binding
// ---------------------------------------------------------------------------

/**
 * Subscribe a component to the effective flags.
 *
 * Every gated surface must read through this rather than reading config
 * directly: the flags arrive mid-session, and a value captured at module scope
 * can never observe that.
 *
 * `getFeatures` returns a stable reference until something actually changes,
 * so this is safe as a useSyncExternalStore snapshot.
 */
export function useFeatures(): ResolvedFeatures {
  return useSyncExternalStore(subscribeFeatures, getFeatures, getFeatures);
}

