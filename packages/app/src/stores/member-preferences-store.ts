import { create } from "zustand";
import { getBackend } from "@/lib/backend";

/**
 * Per-(current user) preferences that live on the member row, scoped to a team.
 *
 * Right now this holds only the member's default agent — the agent pre-selected
 * when starting a session, pinned to the top of the "Recents" sidebar list, and
 * shown as the default in the iOS actor detail. It is keyed by team because a
 * user is a distinct member in each of their teams.
 *
 * It also tracks the team-wide default agent (owner/admin only) and the effective
 * default (member override → team default → null).
 */
interface MemberPreferencesState {
  /** Team the cached `defaultAgentId` belongs to. */
  teamId: string | null;
  /** The team whose preferences actually loaded. Null after a failure, which
   *  is what lets `ensureLoaded` try again. */
  loadedTeamId: string | null;
  defaultAgentId: string | null;
  loading: boolean;
  /** Load (once per team) the caller's default agent. Cheap no-op if already loaded. */
  ensureLoaded: (teamId: string) => Promise<void>;
  /** Force a re-fetch for the given team. */
  reload: (teamId: string) => Promise<void>;
  /**
   * Set (agentId) or clear (null) the caller's default agent. Optimistically
   * updates local state, then reconciles with the server response. Throws on
   * failure (caller decides whether to surface it).
   */
  setDefaultAgent: (teamId: string, agentId: string | null) => Promise<void>;

  // ── Team-wide default agent (owner/admin) ──────────────────────────────────
  /** Team the cached `teamDefaultAgentId` belongs to. */
  teamDefaultTeamId: string | null;
  teamDefaultAgentId: string | null;
  teamDefaultLoading: boolean;
  loadTeamDefaultAgent: (teamId: string) => Promise<void>;
  setTeamDefaultAgent: (teamId: string, agentId: string | null) => Promise<void>;

  // ── Effective default (member override → team default → null) ──────────────
  effectiveDefaultTeamId: string | null;
  effectiveDefaultAgentId: string | null;
  effectiveDefaultLoading: boolean;
  loadEffectiveDefaultAgent: (teamId: string) => Promise<void>;
}

export const useMemberPreferencesStore = create<MemberPreferencesState>((set, get) => ({
  teamId: null,
  loadedTeamId: null,
  defaultAgentId: null,
  loading: false,

  ensureLoaded: async (teamId) => {
    const state = get();
    // `loadedTeamId`, not `teamId`: `reload` sets `teamId` before the request
    // so an in-flight team switch can be detected, which meant a FAILED load
    // left it set and this guard returned for that team forever — the default
    // agent silently stayed empty until a restart.
    if (state.loadedTeamId === teamId && !state.loading) return;
    await get().reload(teamId);
  },

  reload: async (teamId) => {
    set({ loading: true, teamId });
    try {
      const defaultAgentId = await getBackend().actors.getMemberDefaultAgent(teamId);
      // Guard against a team switch racing an in-flight fetch.
      if (get().teamId !== teamId) return;
      set({ defaultAgentId: defaultAgentId ?? null, loading: false, loadedTeamId: teamId });
    } catch (error) {
      console.warn("[MemberPreferences] failed to load default agent", error);
      if (get().teamId === teamId) set({ loading: false });
    }
  },

  setDefaultAgent: async (teamId, agentId) => {
    const prev = get().defaultAgentId;
    // Optimistic update for snappy UI.
    set({ teamId, defaultAgentId: agentId });
    try {
      const confirmed = await getBackend().actors.setMemberDefaultAgent(teamId, agentId);
      if (get().teamId === teamId) set({ defaultAgentId: confirmed ?? null });
    } catch (error) {
      // Roll back the optimistic change.
      if (get().teamId === teamId) set({ defaultAgentId: prev });
      throw error;
    }
  },

  // ── Team-wide default agent ─────────────────────────────────────────────────
  teamDefaultTeamId: null,
  teamDefaultAgentId: null,
  teamDefaultLoading: false,

  loadTeamDefaultAgent: async (teamId) => {
    set({ teamDefaultLoading: true, teamDefaultTeamId: teamId });
    try {
      const teamDefaultAgentId = await getBackend().actors.getTeamDefaultAgent(teamId);
      if (get().teamDefaultTeamId !== teamId) return;
      set({ teamDefaultAgentId: teamDefaultAgentId ?? null, teamDefaultLoading: false });
    } catch (error) {
      console.warn("[MemberPreferences] failed to load team default agent", error);
      if (get().teamDefaultTeamId === teamId) set({ teamDefaultLoading: false });
    }
  },

  setTeamDefaultAgent: async (teamId, agentId) => {
    const prev = get().teamDefaultAgentId;
    set({ teamDefaultTeamId: teamId, teamDefaultAgentId: agentId });
    try {
      const confirmed = await getBackend().actors.setTeamDefaultAgent(teamId, agentId);
      if (get().teamDefaultTeamId === teamId) set({ teamDefaultAgentId: confirmed ?? null });
    } catch (error) {
      if (get().teamDefaultTeamId === teamId) set({ teamDefaultAgentId: prev });
      throw error;
    }
  },

  // ── Effective default ───────────────────────────────────────────────────────
  effectiveDefaultTeamId: null,
  effectiveDefaultAgentId: null,
  effectiveDefaultLoading: false,

  // Fetches the effective (member-then-team fallback) default agent; consumed when opening a new session to pre-select the agent.
  loadEffectiveDefaultAgent: async (teamId) => {
    set({ effectiveDefaultLoading: true, effectiveDefaultTeamId: teamId });
    try {
      const effectiveDefaultAgentId = await getBackend().actors.getEffectiveDefaultAgent(teamId);
      if (get().effectiveDefaultTeamId !== teamId) return;
      set({ effectiveDefaultAgentId: effectiveDefaultAgentId ?? null, effectiveDefaultLoading: false });
    } catch (error) {
      console.warn("[MemberPreferences] failed to load effective default agent", error);
      if (get().effectiveDefaultTeamId === teamId) set({ effectiveDefaultLoading: false });
    }
  },
}));
