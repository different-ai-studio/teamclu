import { useSyncExternalStore } from "react";
import { appStoragePrefix } from "@/lib/config/build-config";

export type SessionPermissionMode = "default" | "fullAccess";

const STORAGE_KEY = `${appStoragePrefix}-session-permission-modes`;
const CHANGE_EVENT = `${appStoragePrefix}-session-permission-modes-changed`;
const MAX_ENTRIES = 200;

type StoredPayload = {
  order: string[];
  fullAccess: Record<string, true>;
};

function emptyPayload(): StoredPayload {
  return { order: [], fullAccess: {} };
}

function readPayload(): StoredPayload {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyPayload();
    const parsed = JSON.parse(raw) as StoredPayload;
    if (!parsed || typeof parsed !== "object") return emptyPayload();
    return {
      order: Array.isArray(parsed.order)
        ? parsed.order.filter((id): id is string => typeof id === "string")
        : [],
      fullAccess:
        parsed.fullAccess && typeof parsed.fullAccess === "object"
          ? parsed.fullAccess
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

export function subscribeSessionPermissionModes(cb: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const handler = () => cb();
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}

export function getSessionPermissionMode(sessionId: string): SessionPermissionMode {
  const id = sessionId.trim();
  if (!id) return "default";
  const { fullAccess } = readPayload();
  return fullAccess[id] ? "fullAccess" : "default";
}

export function setSessionPermissionMode(
  sessionId: string,
  mode: SessionPermissionMode,
): void {
  const id = sessionId.trim();
  if (!id) return;

  const payload = readPayload();

  if (mode === "default") {
    delete payload.fullAccess[id];
    payload.order = payload.order.filter((s) => s !== id);
  } else {
    payload.fullAccess[id] = true;
    payload.order = payload.order.filter((s) => s !== id);
    payload.order.push(id);
    while (payload.order.length > MAX_ENTRIES) {
      const oldest = payload.order.shift();
      if (oldest) delete payload.fullAccess[oldest];
    }
  }

  writePayload(payload);
}

export function shouldAutoAllowSessionPermissions(sessionId: string): boolean {
  return getSessionPermissionMode(sessionId) === "fullAccess";
}

export function useSessionPermissionMode(
  sessionId: string | null,
): SessionPermissionMode {
  return useSyncExternalStore(
    subscribeSessionPermissionModes,
    () => (sessionId ? getSessionPermissionMode(sessionId) : "default"),
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
