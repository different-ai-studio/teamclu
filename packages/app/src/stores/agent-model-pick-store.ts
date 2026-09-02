import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/**
 * Per-(session, agent) model selection store.
 *
 * Design contract — read this before adding writers:
 *
 *  - A pick is ALWAYS a user-initiated choice from the agent pill. There is no
 *    other writer. Daemon MQTT retains MUST NOT call setPick — they expose
 *    `RuntimeInfo.currentModel` separately, and `selectAgentModel` does the
 *    reconciliation at read time. Mixing the two causes the "selected model
 *    keeps reverting to Big Pickle" bug.
 *
 *  - A pick wins over MQTT retain for both UI display and outbound setModel /
 *    runtimeStart payloads. The only way to lose a pick is to overwrite it
 *    with another pick or call clearPick.
 *
 *  - Persisted to localStorage so a page reload does not silently throw the
 *    user's pick away (one of the recurring "弹回" symptoms).
 *
 *  - Scope is THIS session only. "The model this device has been using" is not
 *    kept here: it lives in the daemon (`config::model_mru`, served as
 *    `model-catalog.recent_models`) because gateway and cron runtimes start
 *    inside amuxd and can never read localStorage. A `lastByAgent` map used to
 *    duplicate it here, which meant the answer to "上次用的模型" depended on
 *    which surface asked.
 */

/**
 * Scope for a pick made before the session exists.
 *
 * New chats are draft-first (created on first send), so the pill is mounted and
 * pickable while `sessionId` is still empty. Without a scope to write into, the
 * pick was silently dropped — `handlePickModel` logged
 * `model_pick.deferred_until_session` but deferred nothing, and the dropdown
 * appeared frozen on whatever the retain advertised. Picks land here instead and
 * `promoteDraftPicks` moves them onto the real id at create time.
 */
export const DRAFT_SESSION_PICK_KEY = "__draft__";

function key(sessionId: string, agentId: string): string {
  return `${sessionId}::${agentId}`;
}

type AgentModelPickEntry = {
  modelId: string;
};

interface State {
  bySessionAgent: Record<string, AgentModelPickEntry>;
  setPick: (sessionId: string, agentId: string, modelId: string) => void;
  getPick: (sessionId: string, agentId: string) => string | undefined;
  clearPick: (sessionId: string, agentId: string) => void;
  clearSession: (sessionId: string) => void;
  /** Move draft-scoped picks onto a freshly created session id. */
  promoteDraftPicks: (sessionId: string) => void;
}

export const useAgentModelPickStore = create<State>()(
  persist(
    (set, get) => ({
      bySessionAgent: {},
      setPick: (sessionId, agentId, modelId) => {
        const trimmed = modelId.trim();
        if (!sessionId || !agentId || !trimmed) return;
        set((s) => ({
          bySessionAgent: {
            ...s.bySessionAgent,
            [key(sessionId, agentId)]: { modelId: trimmed },
          },
        }));
      },
      getPick: (sessionId, agentId) => {
        if (!sessionId || !agentId) return undefined;
        return get().bySessionAgent[key(sessionId, agentId)]?.modelId;
      },
      clearPick: (sessionId, agentId) => {
        if (!sessionId || !agentId) return;
        set((s) => {
          const k = key(sessionId, agentId);
          if (!s.bySessionAgent[k]) return s;
          const next = { ...s.bySessionAgent };
          delete next[k];
          return { bySessionAgent: next };
        });
      },
      clearSession: (sessionId) =>
        set((s) => {
          const prefix = `${sessionId}::`;
          const next = { ...s.bySessionAgent };
          for (const k of Object.keys(next)) {
            if (k.startsWith(prefix)) delete next[k];
          }
          return { bySessionAgent: next };
        }),
      promoteDraftPicks: (sessionId) => {
        const target = sessionId.trim();
        if (!target || target === DRAFT_SESSION_PICK_KEY) return;
        set((s) => {
          const prefix = `${DRAFT_SESSION_PICK_KEY}::`;
          const draftKeys = Object.keys(s.bySessionAgent).filter((k) =>
            k.startsWith(prefix),
          );
          if (draftKeys.length === 0) return s;
          const next = { ...s.bySessionAgent };
          for (const k of draftKeys) {
            const agentId = k.slice(prefix.length);
            // An explicit pick already made against the real session wins — the
            // draft is the older intent.
            const realKey = key(target, agentId);
            if (!next[realKey]) next[realKey] = next[k];
            delete next[k];
          }
          return { bySessionAgent: next };
        });
      },
    }),
    {
      name: "teamclu.agent-model-pick.v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ bySessionAgent: s.bySessionAgent }),
    },
  ),
);
