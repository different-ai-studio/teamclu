import {
  clearCachedBootstrapConfig,
  getCloudApiUrlOverride,
  getDefaultCloudApiUrl,
  normalizeCloudApiUrl,
  setCloudApiUrlOverride,
} from "@/lib/config/server-config";

export class InvalidServerUrlError extends Error {
  constructor(raw: string) {
    super(`Not a valid http(s) URL: ${raw}`);
    this.name = "InvalidServerUrlError";
  }
}

/**
 * `null` is the baked official server. Typing that same address into the
 * custom field is the official server too — storing it as an override would
 * hide the baked MQTT broker.
 */
export function resolveServerSwitchTarget(raw: string | null): string | null {
  if (raw === null) return null;
  const normalized = normalizeCloudApiUrl(raw);
  if (!normalized) throw new InvalidServerUrlError(raw);
  const official = getDefaultCloudApiUrl();
  const officialNormalized = official ? normalizeCloudApiUrl(official) : null;
  if (officialNormalized && officialNormalized === normalized) return null;
  return normalized;
}

/**
 * Point the extension at another Cloud API.
 *
 * Sign-out runs first, while the previous URL is still in effect, so the
 * token is revoked against the server that issued it. The bootstrap cache is
 * cleared after that: sign-out itself keeps the broker address on purpose.
 * The side panel then reloads so every reader picks up the new backend.
 */
export async function switchExtensionServer(args: {
  url: string | null;
  signedIn: boolean;
  signOut?: () => Promise<void>;
  reload?: () => void;
}): Promise<"unchanged" | "switched"> {
  const next = resolveServerSwitchTarget(args.url);
  if (next === getCloudApiUrlOverride()) return "unchanged";
  if (args.signedIn) {
    if (!args.signOut) throw new Error("signOut is required when a session is active");
    await args.signOut();
  }
  clearCachedBootstrapConfig();
  setCloudApiUrlOverride(next);
  (args.reload ?? (() => window.location.reload()))();
  return "switched";
}
