import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { useCurrentTeamStore } from "@/stores/current-team";

/**
 * The model a newly created cron job starts pre-selected on.
 *
 * # What this is NOT
 *
 * It is not a run-time fallback. ADR-0007 deleted the daemon MRU precisely
 * because "resolve the model when the job runs" meant the same job ran on a
 * different model depending on which device and which day picked it up
 * (`CronJobDialog.tsx`, the `requiredModel` guard). That property is kept: a
 * job still stores a concrete `payload.model` at creation time, and this store
 * only decides what the form is *pre-filled* with. Changing it never moves an
 * existing job.
 *
 * The gateway's `channels.model` is the other shape — a real run-time default —
 * and deliberately stays where it is (team.toml, team-scoped), because a
 * gateway session is created by an inbound chat message with no form to
 * pre-fill.
 *
 * # Why chat is not a client of this
 *
 * Chat already answers "which model should a new session start on" with
 * [[client-model-mru]] plus `agent-model-pick-store`, whose contract warns that
 * a second writer is what produces the "selected model keeps reverting" bug. So
 * chat reads its own machinery and is only *displayed* alongside this — never
 * driven by it.
 *
 * # Why the key is (backend, team)
 *
 * Same reasoning as `client-model-mru`: model ids are backend-local, so a
 * backend switch must not leave ids that can never match, and catalogs vary by
 * team (the team's shared AI gateway), not by worktree.
 */

function key(backend: string, teamId: string): string {
  return `${backend.trim()}::${teamId.trim()}`;
}

interface State {
  /** `${backend}::${teamId}` → model id. */
  byBackendTeam: Record<string, string>;
  setDefault: (backend: string, teamId: string, modelId: string) => void;
  clearDefault: (backend: string, teamId: string) => void;
}

export const useAutomationDefaultModelStore = create<State>()(
  persist(
    (set) => ({
      byBackendTeam: {},
      setDefault: (backend, teamId, modelId) => {
        const id = modelId.trim();
        const b = backend.trim();
        const t = teamId.trim();
        if (!b || !t) return;
        set((s) => {
          if (!id) {
            if (!(key(b, t) in s.byBackendTeam)) return s;
            const next = { ...s.byBackendTeam };
            delete next[key(b, t)];
            return { byBackendTeam: next };
          }
          if (s.byBackendTeam[key(b, t)] === id) return s;
          return { byBackendTeam: { ...s.byBackendTeam, [key(b, t)]: id } };
        });
      },
      clearDefault: (backend, teamId) => {
        const b = backend.trim();
        const t = teamId.trim();
        if (!b || !t) return;
        set((s) => {
          if (!(key(b, t) in s.byBackendTeam)) return s;
          const next = { ...s.byBackendTeam };
          delete next[key(b, t)];
          return { byBackendTeam: next };
        });
      },
    }),
    {
      name: "teamclu.automation-default-model.v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ byBackendTeam: s.byBackendTeam }),
    },
  ),
);

/**
 * The pre-fill default for `backendType` in the current team, or `''`.
 *
 * Imperative rather than a hook because the cron dialog reads it from inside
 * the effect that builds its initial form state. Never throws: a missing
 * default just means the form opens empty, which is the pre-existing behaviour.
 */
/**
 * The first default set for any of `backends` in `teamId`.
 *
 * The cron dialog knows which backends its catalog offers but not which one
 * this device calls "the" backend, and a device that switched runtimes can hold
 * a default under the old key. Asking across the offered backends answers "is
 * there a default I can pre-fill with" without the dialog having to re-derive
 * the device's backend identity — a second derivation is a second thing to get
 * subtly wrong.
 */
export function automationDefaultForBackends(
  backends: Iterable<string>,
  teamId: string | null | undefined,
): string {
  for (const backend of backends) {
    const found = automationDefaultModel(backend, teamId);
    if (found) return found;
  }
  return "";
}

export function automationDefaultModel(
  backendType: string | null | undefined,
  teamId?: string | null,
): string {
  const backend = backendType?.trim() ?? "";
  if (!backend) return "";
  try {
    const explicit = teamId?.trim() ?? "";
    const team =
      explicit || (useCurrentTeamStore.getState?.()?.team?.id?.trim() ?? "");
    if (!team) return "";
    return (
      useAutomationDefaultModelStore.getState().byBackendTeam[
        key(backend, team)
      ] ?? ""
    );
  } catch {
    return "";
  }
}
