import { Redirect, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
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
import { createSessionsCache } from "../../../../src/features/sessions/session-cache";
import { createSessionsController } from "../../../../src/features/sessions/session-controller";
import { inboxTopic, parseInboxPing } from "../../../../src/features/sessions/inbox";
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
import { supabase } from "../../../../src/lib/supabase/client";
import { getKnownMqttUrl } from "../../../../src/lib/mqtt/config";
import type { ConnectionState } from "../../../../src/lib/mqtt/team-mqtt";
import { SheetModal } from "../../../../src/ui/SheetModal";

/** Host portion of the broker URL — iOS shows `pairing.brokerHost`, not the URL. */
function brokerHostLabel(url: string | null): string {
  if (!url) return "";
  const withoutScheme = url.replace(/^[a-z]+:\/\//i, "");
  return withoutScheme.split("/")[0] ?? "";
}

/** Stable no-op store so `useSyncExternalStore` can run before MQTT connects. */
const noopSubscribe = () => () => {};
const EMPTY_AGENTS_STATE: ConnectedAgentsStoreState = {
  agents: [],
  presenceByAgentId: new Map(),
  isLoading: false,
  errorMessage: null,
};
const emptyAgentsState = () => EMPTY_AGENTS_STATE;

export default function SessionsIndexRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const href = routeToHref(state.route);
  const controllerRef = useRef<ReturnType<typeof createSessionsController> | null>(null);
  const teamIdRef = useRef<string | null>(null);
  const activeTeamId = state.currentTeam?.id ?? "";

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
      void controller.refresh();
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
  // Daemon reachability for the pill above the list. `useTeamMqtt` hands out the
  // shared client, so this tracks the same connection the sessions stream uses.
  const teamMqtt = useTeamMqtt();
  const [daemonState, setDaemonState] = useState<ConnectionState>("disconnected");
  useEffect(() => {
    if (!teamMqtt) {
      setDaemonState("disconnected");
      return;
    }
    return teamMqtt.onConnectionState(setDaemonState);
  }, [teamMqtt]);

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
        if (!parseInboxPing(payload, activeTeamId)) return;
        // A burst of messages is one refresh, not one per message.
        if (refreshTimer) return;
        refreshTimer = setTimeout(() => {
          refreshTimer = null;
          void controllerRef.current?.refresh();
        }, 400);
      });
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [teamMqtt, activeTeamId]);

  // Badge dot, status label and workspace name come off the live runtime, the
  // same three facts iOS reads from its per-session AgentAttachment.
  const agentsStore = useConnectedAgentsStore();
  const agentsState = useSyncExternalStore(
    agentsStore?.subscribe ?? noopSubscribe,
    agentsStore?.getState ?? emptyAgentsState,
    agentsStore?.getState ?? emptyAgentsState,
  );

  if (state.route !== "ready") {
    return <Redirect href={href ?? "/"} />;
  }

  if (state.currentTeam === null) {
    return <Redirect href="/" />;
  }

  const { runtimeBySessionId, workspaceBySessionId } = buildSessionRuntimeMaps({
    sessions: listState.sessions,
    presenceByAgentId: agentsState.presenceByAgentId,
    agentActorIds: new Set(agentsState.agents.map((agent) => agent.agentId)),
  });

  return (
    <>
    <SessionsListScreen
      actorGlyphById={actorGlyphById}
      brokerHost={brokerHostLabel(getKnownMqttUrl())}
      daemonConnectionState={daemonState}
      runtimeBySessionId={runtimeBySessionId}
      workspaceBySessionId={workspaceBySessionId}
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
      onRefresh={() => {
        void controller.refresh();
      }}
      onSelectSession={(sessionId) => {
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
