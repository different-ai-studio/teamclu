import AsyncStorage from "@react-native-async-storage/async-storage";

import { CloudApiError } from "../../lib/cloud-api/client";
import type { TeamSummary } from "./onboarding-types";

/**
 * Launching without network (iOS #1606, `OfflineLaunch.swift`).
 *
 * Bootstrap has to reach the server to list teams and activate one, so with no
 * network it used to dead-end on "Setup failed" — although the device holds a
 * signed-in session and a cache of everything the screens show. What it lacked
 * was the team and member identity to open. This keeps them, and tells "can't
 * reach the server" apart from "the server said no": only the former may fall
 * back to the cached team.
 */

const STORAGE_KEY = "teamclu.onboarding.lastAppContext";

/** The whole context of the last team this device entered. */
export type LastAppContext = {
  team: TeamSummary;
  memberActorId: string;
  isAnonymous: boolean;
};

/**
 * Unlike `remembered-team` this is not a hint for picking among memberships:
 * it is used only when memberships cannot be loaded at all. Every path that
 * forgets the team (sign-out, a dead session) must forget it too.
 *
 * Every method swallows its errors — a throw here would break launch.
 */
export type LastAppContextStore = {
  load: () => Promise<LastAppContext | null>;
  save: (context: LastAppContext) => Promise<void>;
  clear: () => Promise<void>;
};

export function createLastAppContextStore(
  storage: Pick<typeof AsyncStorage, "getItem" | "setItem" | "removeItem"> = AsyncStorage,
): LastAppContextStore {
  return {
    async load() {
      try {
        const raw = await storage.getItem(STORAGE_KEY);
        return raw ? parseLastAppContext(JSON.parse(raw)) : null;
      } catch {
        return null;
      }
    },
    async save(context) {
      try {
        await storage.setItem(STORAGE_KEY, JSON.stringify(context));
      } catch {
        // best-effort
      }
    },
    async clear() {
      try {
        await storage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
    },
  };
}

export function parseLastAppContext(value: unknown): LastAppContext | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const team = record.team as Record<string, unknown> | null | undefined;
  const memberActorId = record.memberActorId;
  if (!team || typeof team !== "object") return null;
  if (typeof team.id !== "string" || !team.id) return null;
  if (typeof memberActorId !== "string" || !memberActorId) return null;
  return {
    team: {
      id: team.id,
      name: typeof team.name === "string" ? team.name : "",
      slug: typeof team.slug === "string" ? team.slug : "",
      role: typeof team.role === "string" ? team.role : "member",
    },
    memberActorId,
    isAnonymous: record.isAnonymous === true,
  };
}

/**
 * True when the request never got an answer: no connection, DNS failure,
 * refused, timed out. A server that answered — any `CloudApiError`, any status
 * — is not "unreachable" and must still surface.
 *
 * React Native's `fetch` reports every transport failure as
 * `TypeError("Network request failed")` (or "…timed out"); aborts come as
 * `AbortError`.
 */
export function isNetworkUnreachableError(error: unknown): boolean {
  if (error instanceof CloudApiError) return false;
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  const message = error.message.toLowerCase();
  if (error instanceof TypeError) {
    return (
      message.includes("network request failed") ||
      message.includes("network request timed out") ||
      message.includes("failed to fetch") ||
      message.includes("network error") ||
      message.includes("load failed")
    );
  }
  return (
    message.includes("the internet connection appears to be offline") ||
    message.includes("could not connect to the server") ||
    message.includes("the request timed out")
  );
}
