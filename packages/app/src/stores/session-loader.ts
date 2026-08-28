import type { SelectedModel, SessionState } from "./session-types";
import { useSessionListStore } from "@/stores/session-list-store";
import { useSessionSelectionStore } from "@/stores/session-selection-store";
import { useSessionMessageStore } from "@/stores/session-message-store";
import { sessionDataCache } from "./session-data-cache";
import { sessionLookupCache, UI_PAGE_SIZE, updateSessionCache } from "./session-cache";
import { cleanupAllChildSessions } from "@/stores/streaming";
import { useStreamingStore } from "@/stores/streaming";
import { trackEvent } from "@/lib/analytics";
import { resolveCurrentMemberActorId } from "@/lib/current-actor";
import { getBackend } from "@/lib/backend";
import { useAuthStore } from "@/stores/auth-store";
import { useCurrentTeamStore } from "@/stores/current-team";

type SessionSet = (fn: ((state: SessionState) => Partial<SessionState>) | Partial<SessionState>) => void;
type SessionGet = () => SessionState;

export function createLoaderActions(set: SessionSet, _get: SessionGet) {
  return {
    resetSessions: () => {
      sessionDataCache.clear();
      sessionLookupCache.clear();
      cleanupAllChildSessions();
      useStreamingStore.getState().clearStreaming();
      set({
        sessions: [],
        pinnedSessionIds: [],
        currentWorkspacePath: null,
        activeSessionId: null,
        messageQueue: [],
        pendingPermissions: [],
        pendingQuestions: [],
        pendingQuestionIdsBySession: {},
        sessionStatuses: {},
        todos: [],
        sessionDiff: [],
        sessionError: null,
        sessionStatus: null,
        highlightedSessionIds: [],
        isLoadingMore: false,
        hasMoreSessions: false,
        visibleSessionCount: UI_PAGE_SIZE,
        archivedSessions: [],
        isLoadingArchivedSessions: false,
        archivedSessionError: null,
        viewingArchivedSessionId: null,
        archivedSessionMessages: {},
      });
    },

    setSelectedModel: (model: SelectedModel | null) => {
      set({ selectedModel: model });
    },

    setDraftInput: (input: string) => {
      set({ draftInput: input });
    },

    clearDraftInput: () => {
      set({ draftInput: "" });
    },

    loadSessions: async (_workspacePath?: string) => {
      set({ isLoading: true, error: null, errorSessionId: null, isLoadingMore: false });
      try {
        await useSessionListStore.getState().load();
        set({ isLoading: false });
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : "Failed to load sessions",
          isLoading: false,
          hasMoreSessions: false,
        });
      }
    },

    loadMoreSessions: async () => {
      await useSessionListStore.getState().loadMore();
    },

    loadArchivedSessions: async (_workspacePath?: string) => {
      set({
        archivedSessions: [],
        isLoadingArchivedSessions: false,
        archivedSessionError: null,
      });
    },

    openArchivedSession: async (_id: string) => {
      set({ archivedSessionError: "Archived OpenCode sessions are no longer supported" });
    },

    closeArchivedSession: () => {
      set({ viewingArchivedSessionId: null });
    },

    restoreSession: async (_id: string) => {
      set({ archivedSessionError: "Archived OpenCode sessions are no longer supported" });
    },

    createSession: async (_workspacePath?: string) => {
      const authSession = useAuthStore.getState().session;
      const currentTeam = useCurrentTeamStore.getState().team;
      const currentMember = useCurrentTeamStore.getState().currentMember;
      if (!authSession || !currentTeam?.id) {
        set({ error: "Cannot create session without team context", isLoading: false });
        return null;
      }

      set({ isLoading: true, error: null, errorSessionId: null });
      try {
        const creatorActorId = await resolveCurrentMemberActorId(
          currentTeam.id,
          authSession.user.id,
          {
            currentTeamId: currentTeam.id,
            currentMemberId: currentMember?.id ?? null,
          },
        );
        if (!creatorActorId) {
          throw new Error(`No member actor found for team ${currentTeam.id}`);
        }

        const agentRows = (await getBackend().actors.listActorDirectory(currentTeam.id))
          .filter((row) => row.actor_type === "agent")
          .slice(0, 2);
        const soleAgent = agentRows.length === 1 ? agentRows[0] : null;

        const { createSessionShell } = await import("@/lib/session-create");
        const { promoteCreatedSessionToUi } = await import("@/lib/promote-created-session");
        const { sessionId } = await createSessionShell({
          teamId: currentTeam.id,
          creatorActorId,
          title: "New chat",
          additionalActorIds: soleAgent ? [soleAgent.id] : [],
        });

        await promoteCreatedSessionToUi({
          sessionId,
          teamId: currentTeam.id,
          title: "New chat",
        });
        trackEvent("session_started");

        const now = new Date();
        const session = {
          id: sessionId,
          title: "New chat",
          messages: [],
          createdAt: now,
          updatedAt: now,
        };

        cleanupAllChildSessions();
        useStreamingStore.getState().clearStreaming();
        set({
          activeSessionId: sessionId,
          currentSessionId: sessionId,
          viewingArchivedSessionId: null,
          isLoading: false,
          messageQueue: [],
          todos: [],
          sessionDiff: [],
          sessionError: null,
          sessionStatus: null,
          pendingQuestions: [],
        });

        return session;
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : "Failed to create session",
          isLoading: false,
        });
        return null;
      }
    },

    setActiveSession: async (id: string) => {
      set({
        activeSessionId: id,
        currentSessionId: id,
        isLoading: true,
        sessionError: null,
        sessionStatus: null,
      });

      try {
        await useSessionMessageStore.getState().reloadActiveSessionMessages();
        set({ isLoading: false });
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : "Failed to load messages",
          isLoading: false,
        });
      }
    },

    archiveSession: async (id: string) => {
      const wasActiveSession =
        useSessionSelectionStore.getState().activeSessionId === id;
      try {
        await useSessionListStore.getState().archiveSession(id);
        sessionDataCache.delete(id);
        if (wasActiveSession) {
          cleanupAllChildSessions();
          useStreamingStore.getState().clearStreaming();
          await useSessionSelectionStore.getState().setActiveSession(null);
        }
        set((state) => ({
          pendingQuestions: state.pendingQuestions.filter((q) => q.sessionId !== id),
          pendingPermissions: state.pendingPermissions.filter(
            (entry) =>
              entry.childSessionId !== id &&
              entry.permission.sessionID !== id &&
              entry.ownerSessionId !== id,
          ),
          sessionStatus: wasActiveSession ? null : state.sessionStatus,
          sessionError: wasActiveSession ? null : state.sessionError,
        }));
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : "Failed to archive session",
        });
      }
    },

    updateSessionTitle: async (id: string, title: string) => {
      try {
        await useSessionListStore.getState().updateSessionTitle(id, title);
        set((state) => {
          const newSessions = state.sessions.map((s) =>
            s.id === id ? { ...s, title } : s,
          );
          updateSessionCache(newSessions);
          return { sessions: newSessions };
        });
      } catch (error) {
        console.error("[Session] Failed to update session title:", error);
        set({
          error:
            error instanceof Error ? error.message : "Failed to update session title",
        });
        throw error;
      }
    },

    loadAllSessionMessages: async (_workspacePath?: string) => {
      // Historical OpenCode bulk load removed; telemetry uses v2 message store.
    },
  };
}
