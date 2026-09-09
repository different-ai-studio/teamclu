import { useSyncExternalStore } from "react";
import { appStoragePrefix } from "@/lib/config/build-config";
import { useSessionListStore } from "@/stores/session-list-store";

export type SessionPermissionMode = "default" | "fullAccess";

const STORAGE_KEY = `${appStoragePrefix}-session-permission-modes`;
const CHANGE_EVENT = `${appStoragePrefix}-session-permission-modes-changed`;
const MAX_ENTRIES = 200;

/**
 * Unattended origins have nobody to answer permission cards. Channel
 * (gateway) and cron sessions therefore default to full access — same policy
 * the daemon applies via `PermissionPolicy::Full`.
 */
export function isUnattendedSessionSource(source?: string | null): boolean {
  return source === "gateway" || source === "cron";
}

type StoredPayload = {
  order: string[];
  /** Explicit fullAccess choices (and legacy seeded entries). */
  fullAccess: Record<string, true>;
  /**
   * Explicit "ask" overrides for unattended sessions. Without this, switching
   * a gateway session back to 默认权限 would immediately flip to fullAccess
   * again via the source default.
   */
  forceDefault: Record<string, true>;
};

function emptyPayload(): StoredPayload {
  return { order: [], fullAccess: {}, forceDefault: {} };
}

function readPayload(): StoredPayload {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyPayload();
    const parsed = JSON.parse(raw) as Partial<StoredPayload>;
    if (!parsed || typeof parsed !== "object") return emptyPayload();
    return {
      order: Array.isArray(parsed.order)
        ? parsed.order.filter((id): id is string => typeof id === "string")
        : [],
      fullAccess:
        parsed.fullAccess && typeof parsed.fullAccess === "object"
          ? parsed.fullAccess
          : {},
      forceDefault:
        parsed.forceDefault && typeof parsed.forceDefault === "object"
          ? parsed.forceDefault
          : {},
    };
  } catch {
    return emptyPayload();
  }
}

function writePayload(payload: StoredPayload): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
    }
  } catch {
    // localStorage unavailable
  }
}

function touchOrder(payload: StoredPayload, id: string): void {
  payload.order = payload.order.filter((s) => s !== id);
  payload.order.push(id);
  while (payload.order.length > MAX_ENTRIES) {
    const oldest = payload.order.shift();
    if (!oldest) continue;
    delete payload.fullAccess[oldest];
    delete payload.forceDefault[oldest];
  }
}

function lookupSessionSource(sessionId: string): string | null {
  return (
    useSessionListStore.getState().rows.find((r) => r.id === sessionId)?.source ??
    null
  );
}

export function subscribeSessionPermissionModes(cb: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const handler = () => cb();
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}

export function getSessionPermissionMode(
  sessionId: string,
  sourceHint?: string | null,
): SessionPermissionMode {
  const id = sessionId.trim();
  if (!id) return "default";
  const { fullAccess, forceDefault } = readPayload();
  if (forceDefault[id]) return "default";
  if (fullAccess[id]) return "fullAccess";
  const source = sourceHint ?? lookupSessionSource(id);
  if (isUnattendedSessionSource(source)) return "fullAccess";
  return "default";
}

export function setSessionPermissionMode(
  sessionId: string,
  mode: SessionPermissionMode,
): void {
  const id = sessionId.trim();
  if (!id) return;

  const payload = readPayload();
  const source = lookupSessionSource(id);

  if (mode === "default") {
    delete payload.fullAccess[id];
    if (isUnattendedSessionSource(source)) {
      payload.forceDefault[id] = true;
      touchOrder(payload, id);
    } else {
      delete payload.forceDefault[id];
      payload.order = payload.order.filter((s) => s !== id);
    }
  } else {
    delete payload.forceDefault[id];
    payload.fullAccess[id] = true;
    touchOrder(payload, id);
  }

  writePayload(payload);
}

export function shouldAutoAllowSessionPermissions(sessionId: string): boolean {
  return getSessionPermissionMode(sessionId) === "fullAccess";
}

export function useSessionPermissionMode(
  sessionId: string | null,
): SessionPermissionMode {
  const source = useSessionListStore((s) =>
    sessionId
      ? (s.rows.find((r) => r.id === sessionId)?.source ?? null)
      : null,
  );
  return useSyncExternalStore(
    subscribeSessionPermissionModes,
    () => (sessionId ? getSessionPermissionMode(sessionId, source) : "default"),
    () => "default",
  );
}

/** Test helper */
export function resetSessionPermissionModesForTests(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
