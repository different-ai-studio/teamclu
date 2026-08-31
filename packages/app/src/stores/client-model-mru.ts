import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { useCurrentTeamStore } from "@/stores/current-team";

/**
 * This client's most-recently-used models — the answer to "which model should a
 * new chat start on?"
 *
 * # Why this lives here and not in the daemon
 *
 * It used to live in the daemon (`config::model_mru`), moved there because
 * gateway and cron runtimes start inside amuxd and can never read localStorage.
 * That reasoning held, but the cost was that amuxd owned a *preference*, and a
 * preference is a thing clients can write wrong: a cold-start client wrote
 * `available[0]`, the daemon recorded that run in its MRU, and every later new
 * session inherited it — a loop that re-confirmed the wrong answer on every
 * restart (`agent-model-auto-persist.ts`).
 *
 * ADR-0007 cuts it the other way: automation entry points (cron jobs, gateway
 * channels) now pin a model when they are *created*, so nothing in the daemon
 * needs to guess any more, and the MRU can go back to being what it always was
 * — a client-side convenience. The feedback loop is gone with it: a bad pick
 * here affects this client and no one else.
 *
 * # Why the key is (backend, team)
 *
 * Model ids are backend-local — `opencode/big-pickle` means nothing to pi — so
 * the backend has to be in the key or a backend switch leaves a list of ids
 * that can never match.
 *
 * Team is in the key because it is the *only* thing catalogs actually vary by.
 * The daemon's store sharded by worktree; auditing 15 worktrees on one device
 * found every difference traced to the team's shared gateway models or to probe
 * staleness, and none to the directory (#742 decision 3). Keying by team tracks
 * the real variable; keying by worktree would re-implement a split that was
 * already disproved.
 *
 * # Scope
 *
 * Per install, deliberately. ADR-0007 accepts that Tauri and iOS each keep their
 * own list and do not converge — this is a preference, not a product promise.
 * Reinstalling loses it, and the first send after that asks the user to choose.
 */

/** Matches the daemon's old cap. Long enough to survive a couple of dead
 *  providers, short enough to stay comprehensible. */
const MAX_RECENT = 10;

function key(backend: string, teamId: string): string {
  return `${backend.trim()}::${teamId.trim()}`;
}

interface State {
  /** `${backend}::${teamId}` → model ids, most recently used first. */
  byBackendTeam: Record<string, string[]>;
  record: (backend: string, teamId: string, modelId: string) => void;
  recentFor: (backend: string, teamId: string) => string[];
  clear: () => void;
}

export const useClientModelMruStore = create<State>()(
  persist(
    (set, get) => ({
      byBackendTeam: {},
      record: (backend, teamId, modelId) => {
        const id = modelId.trim();
        const b = backend.trim();
        const t = teamId.trim();
        if (!id || !b || !t) return;
        set((s) => {
          const k = key(b, t);
          const next = promote(s.byBackendTeam[k] ?? [], id);
          if (next === s.byBackendTeam[k]) return s;
          return { byBackendTeam: { ...s.byBackendTeam, [k]: next } };
        });
      },
      recentFor: (backend, teamId) => {
        if (!backend.trim() || !teamId.trim()) return [];
        return get().byBackendTeam[key(backend, teamId)] ?? [];
      },
      clear: () => set({ byBackendTeam: {} }),
    }),
    {
      name: "teamclu.client-model-mru.v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ byBackendTeam: s.byBackendTeam }),
    },
  ),
);

/** Stable identity so callers never see a fresh [] per read. */
const EMPTY: string[] = [];

/**
 * This client's recent models for `backendType` in the current team.
 *
 * Imperative rather than a hook: two of the three call sites read it from
 * inside a callback or a memo where a hook cannot go. Non-reactive is fine
 * here — the list only changes when the user picks a model explicitly, and
 * that same action writes a pick, which outranks this fallback anyway. So a
 * stale read can never be the value actually shown.
 *
 * Centralised so the team lookup and the empty-key guards live in one place;
 * three call sites each doing their own would be three chances to key the
 * lookup slightly differently.
 *
 * Pass `teamId` whenever the caller already resolved one. The store fallback is
 * only a convenience for callers that have not: it reads `current-team`, which
 * is empty for a moment on cold start, and an empty team here is indistinguish-
 * able from "this device never picked a model" — which is what made the first
 * send after launch stop for a model pick even on a device with an MRU. The
 * send path resolves its team from the session list, so it must hand that one
 * over rather than let this re-derive a different (and briefly empty) answer.
 */
export function clientMruModels(
  backendType: string | null | undefined,
  teamId?: string | null,
): string[] {
  const backend = backendType?.trim() ?? "";
  if (!backend) return EMPTY;
  // Never throw: this feeds the agent pill, and a remembered preference is not
  // worth taking the pill's render down for. Anything unexpected (a store not
  // yet initialised, a test double without `getState`) reads as "no history".
  try {
    const explicit = teamId?.trim() ?? "";
    const team =
      explicit || (useCurrentTeamStore.getState?.()?.team?.id?.trim() ?? "");
    if (!team) return EMPTY;
    return (
      useClientModelMruStore.getState().byBackendTeam[key(backend, team)] ??
      EMPTY
    );
  } catch {
    return EMPTY;
  }
}

/**
 * Move `id` to the front, capped. Returns the ORIGINAL array when nothing
 * changed so the store can skip the write and avoid a needless re-render.
 */
export function promote(recent: readonly string[], id: string): string[] {
  if (recent[0] === id) return recent as string[];
  return [id, ...recent.filter((existing) => existing !== id)].slice(
    0,
    MAX_RECENT,
  );
}

/**
 * First remembered model the live catalog still offers, or `''`.
 *
 * This is the whole reason the MRU is a list and not a single value: the thing
 * a single "last used" names can stop working — a provider gets logged out, a
 * key expires, a model is retired — and pinning something that cannot run is
 * worse than falling through to the next entry. Mirrors the daemon's
 * `model_mru::first_available`, which this replaces.
 *
 * An empty `available` means the catalog has not arrived, NOT that nothing is
 * runnable, so it yields `''` rather than guessing — callers must wait rather
 * than pin a model against an unknown catalog.
 */
export function firstAvailableMruModel(
  recent: readonly string[] | undefined,
  available: readonly { id?: string }[],
): string {
  if (!recent?.length || available.length === 0) return "";
  const offered = new Set(
    available.map((m) => m.id?.trim()).filter((id): id is string => !!id),
  );
  return recent.map((id) => id?.trim()).find((id) => !!id && offered.has(id)) ?? "";
}
