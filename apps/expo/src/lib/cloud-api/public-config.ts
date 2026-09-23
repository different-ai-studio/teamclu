/**
 * `GET /v1/config/public` — the one unauthenticated config endpoint, read by
 * the pre-login screens. Two things live here for Expo:
 *
 *  - `features.auth`: which optional sign-in methods this deployment offers.
 *    Port of iOS `PublicAuthFlags` (apps/ios/.../CloudAPI/PublicAuthFlags.swift).
 *  - `desktopDownloadUrl` (#1588): where the "start a new team" guide sends
 *    people to get the desktop app. Port of iOS `BrandInfo`.
 */

export type PublicAuthFlags = {
  google: boolean;
  phone: boolean;
  password: boolean;
};

/**
 * Used when the server can't be reached at all, or answers with no auth block:
 * every method stays available rather than stripping sign-in options on a
 * network hiccup. FC omits the block when no feature profile is configured,
 * and "absent" means "keep the baked defaults", not "all off".
 */
export const FAIL_OPEN_AUTH_FLAGS: PublicAuthFlags = {
  google: true,
  phone: true,
  password: true,
};

/** FC's own fallback, repeated here for deployments older than #1588. */
export const DEFAULT_DESKTOP_DOWNLOAD_URL =
  "https://github.com/different-ai-studio/teamclu/releases";

export type PublicConfig = {
  /** null when the server sent no `features.auth` block. */
  authFlags: PublicAuthFlags | null;
  /** null when absent or not an http(s) URL. */
  desktopDownloadUrl: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && !!parsed.host;
  } catch {
    return false;
  }
}

/**
 * Within a present `features.auth` block, a missing or non-boolean key reads
 * as off — that is the deployment's explicit choice (iOS does the same).
 */
export function parsePublicConfig(body: unknown): PublicConfig {
  if (!isRecord(body)) return { authFlags: null, desktopDownloadUrl: null };

  const features = isRecord(body.features) ? body.features : null;
  const auth = features && isRecord(features.auth) ? features.auth : null;
  const authFlags: PublicAuthFlags | null = auth
    ? {
        google: auth.google === true,
        phone: auth.phone === true,
        password: auth.password === true,
      }
    : null;

  const desktopDownloadUrl = isHttpUrl(body.desktopDownloadUrl)
    ? body.desktopDownloadUrl.trim()
    : null;

  return { authFlags, desktopDownloadUrl };
}

/** The flags a login screen should render with. */
export function resolveAuthFlags(config: PublicConfig | null | undefined): PublicAuthFlags {
  return config?.authFlags ?? FAIL_OPEN_AUTH_FLAGS;
}

export function resolveDesktopDownloadUrl(config: PublicConfig | null | undefined): string {
  return config?.desktopDownloadUrl ?? DEFAULT_DESKTOP_DOWNLOAD_URL;
}

/**
 * Scheme stripped: people read the link off the phone and type it on a
 * computer. Mirrors iOS `DesktopGuideView.displayURL`.
 */
export function displayUrl(url: string): string {
  for (const prefix of ["https://", "http://"]) {
    if (url.startsWith(prefix)) return url.slice(prefix.length);
  }
  return url;
}

export type LoginMethod = "email" | "password" | "phone";

/** The methods the picker offers, email OTP first (never gated). */
export function availableLoginMethods(flags: PublicAuthFlags): LoginMethod[] {
  const methods: LoginMethod[] = ["email"];
  if (flags.password) methods.push("password");
  if (flags.phone) methods.push("phone");
  return methods;
}

/**
 * If the selected method just got gated off, land on the base method instead
 * of a blank pane.
 */
export function coerceLoginMethod(method: LoginMethod, flags: PublicAuthFlags): LoginMethod {
  return availableLoginMethods(flags).includes(method) ? method : "email";
}

/**
 * Fetch and parse. Never throws: null on transport failure or a non-200, so
 * callers fall back (fail-open flags, default download URL).
 */
export async function fetchPublicConfig(
  baseUrl: string,
  args?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<PublicConfig | null> {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (!normalized) return null;
  const fetchImpl = args?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args?.timeoutMs ?? 8000);
  try {
    const response = await fetchImpl(`${normalized}/v1/config/public`, {
      method: "GET",
      signal: controller.signal,
    });
    if (response.status !== 200) return null;
    return parsePublicConfig(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
