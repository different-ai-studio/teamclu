import { Redirect, useFocusEffect, useRouter } from "expo-router";
import { rememberOpeningSession } from "../../../../src/features/sessions/opening-session";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { routeToHref, useConnectedAgentsStore, useOnboarding, useTeamMqtt } from "../../../_layout";
import { createActorsApi } from "../../../../src/features/actors/actor-api";
import { supabaseAccessToken } from "../../../../src/lib/cloud-api/client";
import {
  loadPinnedSessions,
  subscribePinnedSessions,
  togglePinnedSession,
} from "../../../../src/features/sessions/pinned-sessions";
import { successTone, selectionTick } from "../../../../src/lib/haptics";
import { createConfiguredSessionsApi } from "../../../../src/features/sessions/api-provider";
import { createSessionMutesApi } from "../../../../src/features/sessions/session-mutes";
import { t } from "../../../../src/lib/i18n";
import { showToast } from "../../../../src/ui/Toast";
import { createSessionsCache } from "../../../../src/features/sessions/session-cache";
import { sessionIdsMatchingMessages } from "../../../../src/features/sessions/message-actions";
import { loadSearchableMessages } from "../../../../src/lib/db/local-cache";
import { openCacheDb } from "../../../../src/lib/db/cache-db";
import { createSessionsController } from "../../../../src/features/sessions/session-controller";
import { inboxTopic, parseInboxPing } from "../../../../src/features/sessions/inbox";
import type { SessionLiveActivity } from "../../../../src/features/sessions/live-activity";
import {
  createLiveActivityStore,
  setActiveLiveActivityStore,
  type LiveActivityStore,
} from "../../../../src/features/sessions/live-activity-store";
import { buildSessionRuntimeMaps } from "../../../../src/features/sessions/session-row-runtime";
import type { ConnectedAgentsStoreState } from "../../../../src/features/actors/connected-agents-store";
import { SessionsListScreen } from "../../../../src/features/sessions/screens/SessionsListScreen";
import { ZeroAgentReminderSheet } from "../../../../src/features/sessions/screens/ZeroAgentReminderSheet";
import {
  hasShownZeroAgentReminder,
  markZeroAgentReminderShown,
} from "../../../../src/features/sessions/zero-agent-reminder-store";
import {
  ShortcutsDrawer,
  openShortcutTarget,
} from "../../../../src/features/shortcuts/ShortcutsDrawer";
import { useAppsFeatureEnabled } from "../../../../src/features/apps/use-apps-feature";
import { createTeamAppsApi } from "../../../../src/features/apps/team-apps-api";
import { createIdeasApi } from "../../../../src/features/ideas/idea-api";
import {
  hasAppSessions,
  ideaIdsMissingTitle,
  mergeNames,
  sessionContext,
  type SessionContext,
} from "../../../../src/features/sessions/session-context-names";
import { supabase } from "../../../../src/lib/supabase/client";
import { SheetModal } from "../../../../src/ui/SheetModal";

/** Stable no-op store so `useSyncExternalStore` can run before MQTT connects. */
const noopSubscribe = () => () => {};
const EMPTY_ACTIVITY: ReadonlyMap<string, SessionLiveActivity> = new Map();
const emptyActivity = () => EMPTY_ACTIVITY;
const EMPTY_AGENTS_STATE: ConnectedAgentsStoreState = {
  agents: [],
  presenceByAgentId: new Map(),
  isLoading: false,
  errorMessage: null,
};
const emptyAgentsState = () => EMPTY_AGENTS_STATE;

/**
 * App names and idea titles for the rows' third line, per team, kept for the
 * life of the process so a refresh or a tab switch doesn't blank them.
 */
type ContextNames = {
  apps: ReadonlyMap<string, string>;
  ideas: ReadonlyMap<string, string>;
};
const EMPTY_NAMES: ContextNames = { apps: new Map(), ideas: new Map() };
const contextNamesByTeam = new Map<string, ContextNames>();

export default function SessionsIndexRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const href = routeToHref(state.route);
  const controllerRef = useRef<ReturnType<typeof createSessionsController> | null>(null);
  const teamIdRef = useRef<string | null>(null);
  const activeTeamId = state.currentTeam?.id ?? "";
  const appsEnabled = useAppsFeatureEnabled();

  if (controllerRef.current === null || teamIdRef.current !== activeTeamId) {
    controllerRef.current = createSessionsController(
      createConfiguredSessionsApi(supabase),
      activeTeamId,
      state.currentMemberActorId,
      createSessionsCache(),
    );
    teamIdRef.current = activeTeamId;
  }

  const controller = controllerRef.current;
  const listState = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );

  useEffect(() => {
    if (!activeTeamId) {
      return;
    }

    void controller.load();
  }, [activeTeamId, controller]);

  useFocusEffect(
    useCallback(() => {
      if (!activeTeamId) return;
      void controller.refresh({ quiet: true });
    }, [activeTeamId, controller]),
  );

  const [pinnedSessionIds, setPinnedSessionIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [hasAgents, setHasAgents] = useState(true);
  const [actorGlyphById, setActorGlyphById] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [zeroAgentSheetOpen, setZeroAgentSheetOpen] = useState(false);
  // The muted bell on each row — iOS reads the same list for its row icon.
  const [mutedSessionIds, setMutedSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  useFocusEffect(
    useCallback(() => {
      if (!activeTeamId) return;
      let cancelled = false;
      void createSessionMutesApi({ getAccessToken: supabaseAccessToken(supabase) })
        .listMuted()
        .then((ids) => {
          if (!cancelled) setMutedSessionIds(ids);
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }, [activeTeamId]),
  );
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const zeroAgentCheckedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!activeTeamId) return;
    let cancelled = false;
    void createActorsApi({ getAccessToken: supabaseAccessToken(supabase) })
      .listActors(activeTeamId)
      .then((rows) => {
        if (cancelled) return;
        setHasAgents(rows.some((row) => row.actorType === "agent"));
        const glyphs = new Map<string, string>();
        for (const row of rows) {
          if (row.actorType === "agent") {
            switch (row.agentKind) {
              case "claude":
                glyphs.set(row.actorId, "CC");
                break;
              case "opencode":
                glyphs.set(row.actorId, "OC");
                break;
              case "codex":
                glyphs.set(row.actorId, "CX");
                break;
              default:
                if (row.displayName.length > 0) {
                  glyphs.set(
                    row.actorId,
                    row.displayName.charAt(0).toUpperCase() || "·",
                  );
                }
                break;
            }
          } else if (row.displayName.length > 0) {
            glyphs.set(row.actorId, row.displayName.charAt(0).toUpperCase());
          }
        }
        setActorGlyphById(glyphs);
      })
      .catch(() => {
        // Keep optimistic-true so we don't flash the empty-agents banner on transient errors.
      });
    return () => {
      cancelled = true;
    };
  }, [activeTeamId]);
  useEffect(() => {
    let cancelled = false;
    void loadPinnedSessions().then((set) => {
      if (!cancelled) setPinnedSessionIds(set);
    });
    const unsubscribe = subscribePinnedSessions((next) => {
      if (!cancelled) setPinnedSessionIds(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Show the zero-agent reminder sheet at most once per team. iOS uses
  // SwiftData for "have I shown this?"; here it lives in AsyncStorage.
  useEffect(() => {
    if (!activeTeamId || hasAgents) return;
    if (zeroAgentCheckedRef.current === activeTeamId) return;
    zeroAgentCheckedRef.current = activeTeamId;
    let cancelled = false;
    void hasShownZeroAgentReminder(activeTeamId).then((shown) => {
      if (cancelled || shown) return;
      setZeroAgentSheetOpen(true);
    });
    return () => {
      cancelled = true;
    };
  }, [activeTeamId, hasAgents]);

  const dismissZeroAgentSheet = useCallback(() => {
    setZeroAgentSheetOpen(false);
    if (activeTeamId) {
      void markZeroAgentReminderShown(activeTeamId);
    }
  }, [activeTeamId]);

  // Every hook sits above the redirects below: they used to follow them,
  // so the hook count changed between renders whenever the route flipped.
  // `useTeamMqtt` hands out the shared client the sessions stream uses.
  const teamMqtt = useTeamMqtt();

  // "Agent working / waiting for you" dots (iOS #1567), from each hot session's
  // live stream. One store per team; the detail screen reports local prompts.
  const [liveActivity, setLiveActivity] = useState<LiveActivityStore | null>(null);
  useEffect(() => {
    if (!teamMqtt || !activeTeamId) return;
    const store = createLiveActivityStore({ mqtt: teamMqtt, teamId: activeTeamId });
    setActiveLiveActivityStore(store);
    setLiveActivity(store);
    const sweep = setInterval(() => store.sweep(), 20_000);
    return () => {
      clearInterval(sweep);
      setActiveLiveActivityStore(null);
      store.dispose();
      setLiveActivity(null);
    };
  }, [teamMqtt, activeTeamId]);
  const activityBySessionId = useSyncExternalStore(
    liveActivity?.subscribe ?? noopSubscribe,
    liveActivity?.litSessions ?? emptyActivity,
    liveActivity?.litSessions ?? emptyActivity,
  );
  // Cold start: listen to the most recently active sessions (iOS seeds the same way).
  const seededRef = useRef<LiveActivityStore | null>(null);
  useEffect(() => {
    if (!liveActivity || seededRef.current === liveActivity || listState.sessions.length === 0) return;
    seededRef.current = liveActivity;
    const recent = [...listState.sessions]
      .sort((a, b) => (b.lastMessageAt || b.createdAt).localeCompare(a.lastMessageAt || a.createdAt))
      .slice(0, 8)
      .map((session) => session.sessionId);
    liveActivity.seed(recent);
  }, [liveActivity, listState.sessions]);

  // Unread dots: FC pings `inbox/<auth user id>` when a session gets a message
  // (iOS #1555). Without this the list only learned about new messages when
  // it was refreshed by hand or regained focus.
  useEffect(() => {
    if (!teamMqtt || !activeTeamId) return;
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    void supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      const topic = inboxTopic(data.session?.user?.id ?? "");
      if (!topic) return;
      unsubscribe = teamMqtt.subscribe(topic, (payload) => {
        const pingedSessionId = parseInboxPing(payload, activeTeamId);
        if (!pingedSessionId) return;
        liveActivity?.noteActivity(pingedSessionId);
        // A burst of messages is one refresh, not one per message.
        if (refreshTimer) return;
        refreshTimer = setTimeout(() => {
          refreshTimer = null;
          void controllerRef.current?.refresh({ quiet: true });
        }, 400);
      });
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [teamMqtt, activeTeamId, liveActivity]);

  // Third line of each row: the session's app, else its idea (iOS #1597).
  // Only reaches the network for what the cache can't answer — the apps list
  // when any session has an app, the ideas list when an idea has no title.
  const [contextNames, setContextNames] = useState<ContextNames>(
    () => contextNamesByTeam.get(activeTeamId) ?? EMPTY_NAMES,
  );
  useEffect(() => {
    setContextNames(contextNamesByTeam.get(activeTeamId) ?? EMPTY_NAMES);
  }, [activeTeamId]);
  useEffect(() => {
    if (!activeTeamId || listState.sessions.length === 0) return;
    let cancelled = false;
    const getAccessToken = supabaseAccessToken(supabase);
    const update = (patch: (prev: ContextNames) => ContextNames) => {
      if (cancelled) return;
      const prev = contextNamesByTeam.get(activeTeamId) ?? EMPTY_NAMES;
      const next = patch(prev);
      if (next === prev) return;
      contextNamesByTeam.set(activeTeamId, next);
      setContextNames(next);
    };
    if (appsEnabled && hasAppSessions(listState.sessions)) {
      void createTeamAppsApi({ getAccessToken })
        .listApps(activeTeamId)
        .then((apps) => {
          update((prev) => {
            const apps2 = mergeNames(prev.apps, apps.map((app) => [app.id, app.name] as const));
            return apps2 === prev.apps ? prev : { ...prev, apps: apps2 };
          });
        })
        .catch(() => {});
    }
    const known = contextNamesByTeam.get(activeTeamId) ?? EMPTY_NAMES;
    if (ideaIdsMissingTitle(listState.sessions, known.ideas).size > 0) {
      void createIdeasApi({ getAccessToken })
        .listIdeas(activeTeamId, { includeArchived: true })
        .then((ideas) => {
          update((prev) => {
            const ideas2 = mergeNames(
              prev.ideas,
              ideas.map((idea) => [idea.ideaId, idea.title] as const),
            );
            return ideas2 === prev.ideas ? prev : { ...prev, ideas: ideas2 };
          });
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [activeTeamId, appsEnabled, listState.sessions]);
  const contextBySessionId = useMemo(() => {
    const map = new Map<string, SessionContext>();
    for (const session of listState.sessions) {
      const context = sessionContext(session, contextNames.apps, contextNames.ideas);
      if (context) map.set(session.sessionId, context);
    }
    return map;
  }, [listState.sessions, contextNames]);

  // Badge dot, status label and workspace name come off the live runtime, the
  // same three facts iOS reads from its per-session AgentAttachment.
  const agentsStore = useConnectedAgentsStore();
  const agentsState = useSyncExternalStore(
    agentsStore?.subscribe ?? noopSubscribe,
    agentsStore?.getState ?? emptyAgentsState,
    agentsStore?.getState ?? emptyAgentsState,
  );

  const searchMessageContent = useCallback(
    async (query: string) => {
      const rows = await loadSearchableMessages(await openCacheDb(), activeTeamId);
      return sessionIdsMatchingMessages(rows, query);
    },
    [activeTeamId],
  );

  if (state.route !== "ready") {
    return <Redirect href={href ?? "/"} />;
  }

  if (state.currentTeam === null) {
    return <Redirect href="/" />;
  }

  const { runtimeBySessionId } = buildSessionRuntimeMaps({
    sessions: listState.sessions,
    presenceByAgentId: agentsState.presenceByAgentId,
    agentActorIds: new Set(agentsState.agents.map((agent) => agent.agentId)),
  });

  return (
    <>
    <SessionsListScreen
      searchMessageContent={searchMessageContent}
      actorGlyphById={actorGlyphById}
      runtimeBySessionId={runtimeBySessionId}
      contextBySessionId={contextBySessionId}
      hasAgents={hasAgents}
      onInviteAgent={() => router.push("/(app)/invite")}
      onArchiveBatch={async (sessionIds) => {
        const now = new Date().toISOString();
        const api = createConfiguredSessionsApi(supabase);
        for (const id of sessionIds) {
          try {
            await api.setSessionArchived(id, now);
          } catch {
            // continue
          }
        }
        successTone();
        await controller.refresh();
      }}
      onLoad={() => {
        void controller.load();
      }}
      onMarkBatchRead={async (sessionIds) => {
        const actorId = state.currentMemberActorId;
        if (!actorId) return;
        const api = createConfiguredSessionsApi(supabase);
        for (const id of sessionIds) {
          try {
            await api.markSessionRead(id, actorId, null);
          } catch {
            // continue
          }
        }
        await controller.refresh();
      }}
      onMarkBatchUnread={async (sessionIds) => {
        const actorId = state.currentMemberActorId;
        if (!actorId) return;
        const api = createConfiguredSessionsApi(supabase);
        for (const id of sessionIds) {
          try {
            await api.markSessionUnread(id, actorId);
          } catch {
            // continue
          }
        }
        await controller.refresh();
      }}
      onNewSession={() => {
        router.push("/(app)/new-session");
      }}
      onTogglePin={async (sessionId) => {
        selectionTick();
        await togglePinnedSession(sessionId);
      }}
      pinnedSessionIds={pinnedSessionIds}
      mutedSessionIds={mutedSessionIds}
      activityBySessionId={activityBySessionId}
      onRenameSession={async (sessionId, title) => {
        try {
          await createConfiguredSessionsApi(supabase).renameSession(sessionId, title);
          await controller.refresh();
        } catch (err) {
          showToast("error", err instanceof Error ? err.message : t("Couldn't rename session."));
        }
      }}
      onToggleMute={async (sessionId, muted) => {
        // Optimistic: flip the bell now, put it back if the server refuses.
        setMutedSessionIds((prev) => {
          const next = new Set(prev);
          if (muted) next.add(sessionId);
          else next.delete(sessionId);
          return next;
        });
        try {
          await createSessionMutesApi({
            getAccessToken: supabaseAccessToken(supabase),
          }).setMuted(sessionId, muted);
        } catch (err) {
          setMutedSessionIds((prev) => {
            const next = new Set(prev);
            if (muted) next.delete(sessionId);
            else next.add(sessionId);
            return next;
          });
          showToast("error", err instanceof Error ? err.message : t("Couldn't update notifications."));
        }
      }}
      onRefresh={() => {
        void controller.refresh();
      }}
      onSelectSession={(sessionId) => {
        const summary = listState.sessions.find((session) => session.sessionId === sessionId);
        if (summary) rememberOpeningSession(summary);
        router.push(`/(app)/sessions/${sessionId}`);
      }}
      onShortcuts={() => {
        setShortcutsOpen(true);
      }}
      state={listState}
    />
    <SheetModal
      onRequestClose={dismissZeroAgentSheet}
      visible={zeroAgentSheetOpen}
    >
      <ZeroAgentReminderSheet
        onAdd={() => {
          dismissZeroAgentSheet();
          router.push("/(app)/invite");
        }}
        onDismiss={dismissZeroAgentSheet}
      />
    </SheetModal>
    <ShortcutsDrawer
      isPresented={shortcutsOpen}
      onClose={() => setShortcutsOpen(false)}
      appsEnabled={appsEnabled}
      onOpenApps={() => router.push("/(app)/team-apps")}
      onOpenSettings={() => router.push("/(app)/settings")}
      onOpenShortcut={(shortcut) => {
        void openShortcutTarget(shortcut, { push: router.push });
      }}
      profileName={state.currentTeam?.name ?? "Signed out"}
      profileSubtitle={
        state.currentTeam ? `Team · ${state.currentTeam.name}` : null
      }
      teamId={activeTeamId}
    />
    </>
  );
}
