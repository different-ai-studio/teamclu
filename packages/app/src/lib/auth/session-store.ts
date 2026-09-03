// SessionStore — local persistence + cross-tab sync + auto-refresh for the
// TeamClu auth session. Replaces what supabase-js's GoTrueClient previously
// provided for the web/desktop frontend.
//
// Responsibilities:
//   - persist the session under `teamclu.session.v1` in localStorage
//   - cache it in module-level memory for synchronous reads
//   - notify subscribers on change (in-process + cross-tab via BroadcastChannel
//     with `storage` event fallback)
//   - schedule auto-refresh 60s before `expires_at`; dedup concurrent refreshes
//
// The actual refresh HTTP call is injected by `auth-client` to avoid an import
// cycle.

import type { AuthChangeEvent, AuthListener, Session } from "@/lib/auth/types";

const STORAGE_KEY = "teamclu.session.v1";
// Pre-rebrand key. A historical fact about what sits in users' localStorage, not
// a brand string — renaming it would sign every existing install out.
const LEGACY_BRAND_STORAGE_KEY = "teamclaw.session.v1";
const CHANNEL_NAME = "teamclu.auth";
const REFRESH_LEEWAY_SECONDS = 60;

type RefreshReason = "refresh" | "adopt";
type Refresher = (refreshToken: string, reason: RefreshReason) => Promise<Session>;

let cachedSession: Session | null | undefined = undefined; // undefined = not yet hydrated
let listeners = new Set<AuthListener>();
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let inFlightRefresh: Promise<Session> | null = null;
// Bumped whenever the session identity changes (sign-in/out/replace). An
// in-flight refresh captures this at start and bails if it changed while the
// network round-trip was outstanding — otherwise a refresh that started before
// sign-out would resolve and re-emit TOKEN_REFRESHED, resurrecting the old
// identity and re-running bootstrap with a stale token.
let authGeneration = 0;
let refresher: Refresher | null = null;
let broadcastChannel: BroadcastChannel | null = null;
let storageListenerInstalled = false;
let visibilityListenerInstalled = false;

function safeLocalStorage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function isValidSession(value: unknown): value is Session {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<Session> & { user?: { id?: unknown } };
  return (
    typeof v.access_token === "string" &&
    typeof v.refresh_token === "string" &&
    typeof v.expires_at === "number" &&
    !!v.user &&
    typeof v.user === "object" &&
    typeof v.user.id === "string" &&
    !!v.user.id
  );
}

function readPersistedSession(): Session | null {
  const ls = safeLocalStorage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (isValidSession(parsed)) return parsed;
      // Stale/partial session from a previous broken build — drop it so we
      // don't crash mapSession downstream.
      try { ls.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    }
  } catch {
    // fall through to legacy migration
  }
  // One-time move off the pre-rebrand key, before the older supabase-js path.
  const rebranded = migrateLegacyBrandSession(ls);
  if (rebranded) return rebranded;
  // Attempt one-time migration from legacy supabase-js localStorage keys.
  return migrateLegacySupabaseSession(ls);
}

/**
 * One-time migration: installs from before the teamclaw → teamclu rebrand hold
 * their session under `teamclaw.session.v1`. Re-key it rather than letting the
 * miss fall through, which would sign the user out on first launch of the
 * renamed build.
 */
function migrateLegacyBrandSession(ls: Storage): Session | null {
  try {
    const raw = ls.getItem(LEGACY_BRAND_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isValidSession(parsed)) {
      ls.removeItem(LEGACY_BRAND_STORAGE_KEY);
      return null;
    }
    ls.setItem(STORAGE_KEY, raw);
    ls.removeItem(LEGACY_BRAND_STORAGE_KEY);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * One-time migration: pre-existing TeamClu installs persisted their auth
 * session via supabase-js under `sb-<project-ref>-auth-token`. We translate
 * that to the new `teamclu.session.v1` key (and remove all `sb-*` keys we
 * find) so existing users are not silently signed out after this release.
 */
function migrateLegacySupabaseSession(ls: Storage): Session | null {
  const legacyKeys: string[] = [];
  let authKey: string | null = null;
  try {
    for (let i = 0; i < ls.length; i++) {
      const key = ls.key(i);
      if (!key) continue;
      if (key.startsWith("sb-")) {
        legacyKeys.push(key);
        if (/^sb-.+-auth-token$/.test(key) && !authKey) authKey = key;
      }
    }
  } catch {
    return null;
  }
  if (legacyKeys.length === 0) return null;

  let migrated: Session | null = null;
  if (authKey) {
    try {
      const raw = ls.getItem(authKey);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Session> & {
          currentSession?: Partial<Session>;
        };
        // supabase-js sometimes wraps under { currentSession, expiresAt }
        const src: Partial<Session> & { user?: unknown } = parsed.currentSession
          ? (parsed.currentSession as Partial<Session>)
          : (parsed as Partial<Session>);
        const accessToken = typeof src.access_token === "string" ? src.access_token : null;
        const refreshToken = typeof src.refresh_token === "string" ? src.refresh_token : null;
        const expiresAt =
          typeof src.expires_at === "number"
            ? src.expires_at
            : typeof (src as { expiresAt?: unknown }).expiresAt === "number"
              ? ((src as { expiresAt: number }).expiresAt)
              : null;
        const user = (src.user && typeof src.user === "object" ? src.user : null) as Session["user"] | null;
        if (accessToken && refreshToken && expiresAt && user) {
          migrated = {
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_at: expiresAt,
            token_type: typeof src.token_type === "string" ? src.token_type : "bearer",
            expires_in: typeof src.expires_in === "number" ? src.expires_in : undefined,
            user,
          };
        }
      }
    } catch {
      migrated = null;
    }
  }

  // Best-effort cleanup of all sb-* keys (auth token + provider token + any others).
  for (const key of legacyKeys) {
    try {
      ls.removeItem(key);
    } catch {
      // ignore
    }
  }

  if (migrated) {
    try {
      ls.setItem(STORAGE_KEY, JSON.stringify(migrated));
    } catch {
      // ignore
    }
    if (import.meta.env?.DEV) {
      // eslint-disable-next-line no-console
      console.log("[auth] migrated legacy supabase-js session", { keys: legacyKeys });
    }
  } else if (import.meta.env?.DEV) {
    // eslint-disable-next-line no-console
    console.log("[auth] cleared legacy supabase-js keys (no valid session)", { keys: legacyKeys });
  }
  return migrated;
}

function writePersistedSession(session: Session | null) {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    if (session) ls.setItem(STORAGE_KEY, JSON.stringify(session));
    else ls.removeItem(STORAGE_KEY);
  } catch {
    // localStorage may be full or blocked; degrade silently
  }
}

function ensureCrossTab() {
  if (typeof window === "undefined") return;
  if (!broadcastChannel && typeof BroadcastChannel !== "undefined") {
    try {
      broadcastChannel = new BroadcastChannel(CHANNEL_NAME);
      broadcastChannel.onmessage = (ev: MessageEvent) => {
        const next = (ev.data ?? null) as Session | null;
        if (sessionsEqual(cachedSession ?? null, next)) return;
        cachedSession = next;
        scheduleRefresh();
        emit(next ? "SIGNED_IN" : "SIGNED_OUT", next);
      };
    } catch {
      broadcastChannel = null;
    }
  }
  if (!storageListenerInstalled) {
    window.addEventListener("storage", (ev: StorageEvent) => {
      if (ev.key !== STORAGE_KEY) return;
      const next = ev.newValue ? (safeParse(ev.newValue) as Session | null) : null;
      if (sessionsEqual(cachedSession ?? null, next)) return;
      cachedSession = next;
      scheduleRefresh();
      emit(next ? "SIGNED_IN" : "SIGNED_OUT", next);
    });
    storageListenerInstalled = true;
  }
  if (!visibilityListenerInstalled && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") scheduleRefresh();
    });
    visibilityListenerInstalled = true;
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sessionsEqual(a: Session | null, b: Session | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.access_token === b.access_token && a.refresh_token === b.refresh_token;
}

function emit(event: AuthChangeEvent, session: Session | null) {
  for (const l of listeners) {
    try {
      l(event, session);
    } catch (e) {
      console.warn("[auth] listener threw", e);
    }
  }
}

function clearRefreshTimer() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

function scheduleRefresh() {
  clearRefreshTimer();
  const session = cachedSession ?? null;
  if (!session || !session.expires_at || !refresher) return;
  const expiresAtMs = session.expires_at * 1000;
  const fireAt = expiresAtMs - REFRESH_LEEWAY_SECONDS * 1000;
  const delay = Math.max(0, fireAt - Date.now());
  refreshTimer = setTimeout(() => {
    void refreshSession().catch(() => {
      // refresh failed — refreshSession already clears the session on hard failure
    });
  }, delay);
}

export function configureSessionStore(args: { refresher: Refresher }) {
  refresher = args.refresher;
  // first hydration: load persisted session into the in-memory cache.
  if (cachedSession === undefined) {
    cachedSession = readPersistedSession();
  }
  ensureCrossTab();
  scheduleRefresh();
}

export function getSession(): Session | null {
  if (cachedSession === undefined) {
    cachedSession = readPersistedSession();
    ensureCrossTab();
    scheduleRefresh();
  }
  return cachedSession;
}

export function setSession(next: Session | null, event?: AuthChangeEvent) {
  const prev = cachedSession ?? null;
  if (!sessionsEqual(prev, next)) {
    // Identity changed (sign in/out or account switch): invalidate any refresh
    // that was already in flight so its late resolution cannot re-install this
    // now-stale identity, and let a fresh refresh start for the new session.
    authGeneration += 1;
    inFlightRefresh = null;
  }
  cachedSession = next;
  writePersistedSession(next);
  if (broadcastChannel) {
    try {
      broadcastChannel.postMessage(next);
    } catch {
      // ignore
    }
  }
  scheduleRefresh();
  const e: AuthChangeEvent = event ?? (next ? (prev ? "TOKEN_REFRESHED" : "SIGNED_IN") : "SIGNED_OUT");
  emit(e, next);
}

export function subscribe(listener: AuthListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Refresh the access token. Concurrent callers receive the same in-flight
 * promise. On hard failure (4xx invalid_grant / refresh_token_not_found),
 * the session is cleared and a SIGNED_OUT event is emitted.
 */
export function refreshSession(): Promise<Session> {
  if (inFlightRefresh) return inFlightRefresh;
  const session = cachedSession ?? null;
  if (!session || !session.refresh_token) {
    return Promise.reject(new Error("No refresh token available."));
  }
  if (!refresher) {
    return Promise.reject(new Error("SessionStore not configured with a refresher."));
  }
  const fn = refresher;
  const refreshToken = session.refresh_token;
  const startGeneration = authGeneration;
  const stale = () => authGeneration !== startGeneration;
  inFlightRefresh = (async () => {
    try {
      const next = await fn(refreshToken, "refresh");
      // Session was cleared or replaced while this refresh was in flight
      // (e.g. the user signed out). Do NOT re-install the old identity.
      if (stale()) {
        throw new Error("session changed during refresh");
      }
      setSession(next, "TOKEN_REFRESHED");
      return next;
    } catch (err) {
      const e = err as { status?: number; code?: string };
      if (
        !stale() &&
        e?.status &&
        e.status >= 400 &&
        e.status < 500 &&
        (e.code === "invalid_grant" || e.code === "refresh_token_not_found" || e.status === 401)
      ) {
        setSession(null, "SIGNED_OUT");
      }
      throw err;
    } finally {
      // Only clear the shared handle if this refresh is still the current one.
      // A sign-out/replace during the window bumps the generation and already
      // reset inFlightRefresh (possibly to a newer refresh) — leave it alone.
      if (!stale()) inFlightRefresh = null;
    }
  })();
  return inFlightRefresh;
}

/**
 * Adopt a session minted out-of-band (e.g. switch_active_team returns a fresh
 * refresh_token for a brand-new server session). Exchanges it via the configured
 * refresher for a full Session — that refresh re-runs the access-token hook, so
 * the new JWT carries the new org_id — then installs it (emits TOKEN_REFRESHED).
 */
export async function adoptRefreshToken(refreshToken: string): Promise<Session> {
  if (!refresher) throw new Error("SessionStore not configured with a refresher.");
  const next = await refresher(refreshToken, "adopt");
  setSession(next, "TOKEN_REFRESHED");
  return next;
}

/**
 * Return a guaranteed-fresh user access token for direct FC calls made from
 * Tauri commands (Design 2: "Tauri uses its own token; the daemon uses its
 * own; neither crosses"). Reads the current session and, if it is within the
 * refresh leeway of expiry, proactively refreshes before returning. Throws
 * "not logged in" when there is no session (humanized by `lib/fc-error.ts`).
 *
 * This replaces the old flow where the Rust side read a `supabase_jwt` cached
 * in `teamclu.json` that nothing refreshed after the JWT bridge was removed.
 */
export async function getFreshAccessToken(): Promise<string> {
  let session = getSession();
  if (!session?.access_token) {
    throw new Error("not logged in");
  }
  const expiresAtMs = session.expires_at ? session.expires_at * 1000 : null;
  if (
    expiresAtMs !== null &&
    expiresAtMs - Date.now() < REFRESH_LEEWAY_SECONDS * 1000
  ) {
    try {
      session = await refreshSession();
    } catch {
      // Refresh failed (e.g. offline). Fall back to the current token; if it is
      // truly expired the FC call surfaces a 401 and the UI can re-auth.
      session = getSession() ?? session;
    }
  }
  if (!session?.access_token) {
    throw new Error("not logged in");
  }
  return session.access_token;
}

/** Test-only: reset all module state. */
export function __resetSessionStoreForTests() {
  clearRefreshTimer();
  listeners = new Set();
  cachedSession = undefined;
  inFlightRefresh = null;
  authGeneration = 0;
  refresher = null;
  if (broadcastChannel) {
    try {
      broadcastChannel.close();
    } catch {
      // ignore
    }
    broadcastChannel = null;
  }
  storageListenerInstalled = false;
  visibilityListenerInstalled = false;
  const ls = safeLocalStorage();
  if (ls) ls.removeItem(STORAGE_KEY);
}
