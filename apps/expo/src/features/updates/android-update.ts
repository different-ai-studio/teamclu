/**
 * In-app update check for the sideloaded Android APK.
 *
 * The APK is not distributed through a store, so nothing tells an installed
 * copy that a newer one exists. Release CI (.github/workflows/release-android.yml
 * → scripts/publish-android-apk.py) publishes `android/latest.json` next to the
 * release page; this module reads it and decides whether to offer an update.
 *
 * Pure logic only — the download / install side lives in apk-installer.ts.
 */

export type AndroidUpdateManifest = {
  version: string;
  versionCode: number;
  url: string;
  size: number;
  sha256: string;
  notes: string;
};

/** How often a foregrounded app re-reads the manifest. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The manifest URL baked in at build time; unset (dev, iOS) → feature off. */
export function androidUpdateManifestUrl(): string | null {
  const value = process.env.EXPO_PUBLIC_ANDROID_UPDATE_URL?.trim();
  return value ? value : null;
}

export function parseAndroidUpdateManifest(raw: unknown): AndroidUpdateManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const versionCode = typeof m.versionCode === "number" ? m.versionCode : Number(m.versionCode);
  if (!Number.isInteger(versionCode) || versionCode <= 0) return null;
  if (typeof m.url !== "string" || !/^https:\/\//i.test(m.url)) return null;
  if (typeof m.version !== "string" || !m.version) return null;
  return {
    version: m.version,
    versionCode,
    url: m.url,
    size: typeof m.size === "number" && m.size > 0 ? m.size : 0,
    sha256: typeof m.sha256 === "string" ? m.sha256 : "",
    notes: typeof m.notes === "string" ? m.notes : "",
  };
}

/**
 * `installedVersionCode` comes from expo-application's `nativeBuildVersion`
 * (a string on Android). Unknown → never offer: a dev build or a broken read
 * must not nag every launch.
 */
export function parseInstalledVersionCode(value: string | null | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function isUpdateAvailable(
  manifest: AndroidUpdateManifest | null,
  installedVersionCode: number | null,
  dismissedVersionCode: number | null = null,
): manifest is AndroidUpdateManifest {
  if (!manifest || installedVersionCode === null) return false;
  if (manifest.versionCode <= installedVersionCode) return false;
  // "Later" hides this version for the rest of the process; a newer one shows again.
  return dismissedVersionCode === null || manifest.versionCode > dismissedVersionCode;
}

export function shouldCheckForUpdate(
  lastCheckedAt: number | null,
  now: number,
  intervalMs: number = UPDATE_CHECK_INTERVAL_MS,
): boolean {
  return lastCheckedAt === null || now - lastCheckedAt >= intervalMs;
}

export async function fetchAndroidUpdateManifest(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AndroidUpdateManifest | null> {
  // The CDN edge may hold the mutable manifest; a query string sidesteps it.
  const sep = url.includes("?") ? "&" : "?";
  const response = await fetchImpl(`${url}${sep}t=${Date.now()}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) return null;
  return parseAndroidUpdateManifest(await response.json());
}

export function downloadProgress(written: number, expected: number): number {
  if (!(expected > 0)) return 0;
  return Math.max(0, Math.min(1, written / expected));
}
