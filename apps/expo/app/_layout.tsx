import "../src/lib/polyfills";
import "../src/lib/i18n";

import { initSentry, wrapRoot } from "../src/lib/telemetry/sentry";

// Before any other module runs, so an error thrown while the tree is still
// being built is still reported.
initSentry();

import Constants from "expo-constants";
import * as Linking from "expo-linking";
import * as Notifications from "expo-notifications";
import { router, Slot } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { AppState, Platform, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ToastHost, showToast } from "../src/ui/Toast";
import { createConfiguredInviteApi, parseInviteToken } from "../src/features/onboarding/invite-api";
import { isOAuthCallbackUrl } from "../src/features/onboarding/onboarding-oauth";
import { createOnboardingController } from "../src/features/onboarding/onboarding-store";
import type {
  OnboardingRoute,
  OnboardingState,
} from "../src/features/onboarding/onboarding-types";
import {
  clearPendingInviteToken,
  loadPendingInviteToken,
  savePendingInviteToken,
} from "../src/features/onboarding/pending-invite";
import { createOnboardingApi } from "../src/lib/supabase/onboarding-api";
import { supabaseAccessToken } from "../src/lib/cloud-api/client";
import { supabase } from "../src/lib/supabase/client";
import { colors } from "../src/ui/theme";
import { appStatusBarProps } from "../src/ui/status-bar";
import { createTeamMqttClient, type TeamMqttClient } from "../src/lib/mqtt/team-mqtt";
import { clearCachedMqttUrl, resolveMqttUrl } from "../src/lib/mqtt/config";
import { createAgentAccessApi } from "../src/features/actors/agent-access-api";
import { createRuntimeStateSubscriber } from "../src/features/actors/runtime-state-subscriber";
import {
  createConnectedAgentsStore,
  type ConnectedAgentsStore,
} from "../src/features/actors/connected-agents-store";
import { createConnectedAgentsCache } from "../src/features/actors/connected-agents-cache";
import { getExpoDeviceId } from "../src/features/notifications/device-id";
import {
  notificationResponseDedupeKey,
  notificationResponseToSessionHref,
} from "../src/features/notifications/notification-routing";
import { createPresenceApi } from "../src/features/notifications/presence-api";
import { createForegroundPresenceHeartbeat } from "../src/features/notifications/presence-heartbeat";
import { reportExpoClientVersion } from "../src/features/notifications/report-client-version";
import { cloudApiBaseUrl, createCloudApiClient } from "../src/lib/cloud-api/client";
import { hydrateCloudApiUrl } from "../src/lib/cloud-api/cloud-api-url";
import { tearDownCloudAuthForServerSwitch } from "../src/lib/auth/cloud-auth";
import { createPushTokenApi } from "../src/features/notifications/push-token-api";
import { registerNativePushToken } from "../src/features/notifications/push-registration";
import { getDb } from "../src/lib/db/sqlite";
import { decodeActorPresence } from "../src/features/actors/actor-presence";
import { setActiveUnreadTeam } from "../src/features/sessions/unread-store";

const onboardingApi = createOnboardingApi(supabase);

type OnboardingController = ReturnType<typeof createOnboardingController>;

type OnboardingContextValue = {
  controller: OnboardingController;
  state: OnboardingState;
  retryBootstrap: () => Promise<void>;
  /**
   * After the user saves a Cloud API address in ServerSettingsSheet: if the
   * base URL changed, tear down MQTT + the old session (tokens are not
   * URL-scoped), then re-bootstrap. Same-URL re-save is a retry.
   */
  applyServerChange: () => Promise<void>;
};

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

export function useOnboarding() {
  const context = useContext(OnboardingContext);

  if (!context) {
    throw new Error("useOnboarding must be used inside RootLayout");
  }

  return context;
}

export const TeamMqttContext = createContext<TeamMqttClient | null>(null);

export function useTeamMqtt(): TeamMqttClient | null {
  return useContext(TeamMqttContext);
}

export const ConnectedAgentsContext = createContext<ConnectedAgentsStore | null>(null);

export function useConnectedAgentsStore(): ConnectedAgentsStore | null {
  return useContext(ConnectedAgentsContext);
}

export function routeToHref(route: OnboardingRoute): string | null {
  switch (route) {
    case "needsAuth":
      return "/welcome";
    case "createTeam":
      return "/create-team";
    case "selectTeam":
      return "/select-team";
    case "ready":
      return "/(app)/sessions";
    case "loading":
    case "failed":
      return null;
  }
}

function OnboardingProvider({ children }: { children: ReactNode }) {
  const [controller] = useState(() => createOnboardingController(onboardingApi));
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );
  const lastClaimedTokenRef = useRef<string | null>(null);
  const teamMqttRef = useRef<TeamMqttClient | null>(null);
  const connectedAgentsStoreRef = useRef<ConnectedAgentsStore | null>(null);
  const lastNotificationDedupeKeyRef = useRef<string | null>(null);
  const activeCloudBaseUrlRef = useRef<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [teamMqtt, setTeamMqtt] = useState<TeamMqttClient | null>(null);
  const [connectedAgentsStore, setConnectedAgentsStore] = useState<ConnectedAgentsStore | null>(null);

  useEffect(() => {
    let cancelled = false;
    void hydrateCloudApiUrl().then(() => {
      if (cancelled) return;
      try {
        activeCloudBaseUrlRef.current = cloudApiBaseUrl();
      } catch {
        activeCloudBaseUrlRef.current = null;
      }
      setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    void controller.bootstrap().catch(() => {
      // Error state is stored inside the controller for the routes to render.
    });
  }, [controller, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    const { data } = supabase.auth.onAuthStateChange(() => {
      void controller.bootstrap().catch(() => {
        // Keep the controller state as the source of truth for auth/bootstrap failures.
      });
    });

    return () => {
      data.subscription.unsubscribe();
    };
  }, [controller, hydrated]);

  // Mirrors iOS `AppOnboardingCoordinator` invite token replay. Any
  // `teamclu://invite/<token>` link — whether the OS hands it to us on
  // cold start or while the app is foregrounded — is stashed for later
  // replay; the route `ready` effect below redeems it once we know the
  // user is signed in.
  useEffect(() => {
    const handleUrl = (url: string | null | undefined) => {
      // The OAuth redirect is a deep link, so this listener — not
      // `openAuthSessionAsync`'s return value — is what reliably carries a
      // Google/Apple sign-in back to us on Android. Completing it here is
      // idempotent; the controller spends each callback once.
      if (isOAuthCallbackUrl(url)) {
        void controller.completeOAuthFromUrl(url!).catch(() => {
          // Rendered from controller state by the auth screen.
        });
        return;
      }

      const token = parseInviteToken(url);
      if (!token) return;
      void savePendingInviteToken(token).then(() => {
        void controller.bootstrap();
      });
    };
    void Linking.getInitialURL().then(handleUrl);
    const subscription = Linking.addEventListener("url", (event) => {
      handleUrl(event.url);
    });
    return () => {
      subscription.remove();
    };
  }, [controller]);

  useEffect(() => {
    if (state.route !== "ready") return;
    let cancelled = false;
    void (async () => {
      const token = await loadPendingInviteToken();
      if (!token || cancelled) return;
      if (token === lastClaimedTokenRef.current) return;
      lastClaimedTokenRef.current = token;
      try {
        const result = await createConfiguredInviteApi(supabase).claim(token);
        if (cancelled) return;
        showToast(
          "success",
          result.displayName
            ? `Joined as ${result.displayName}`
            : "Joined team via invite",
        );
        await controller.bootstrap();
      } catch (err) {
        if (cancelled) return;
        showToast(
          "error",
          err instanceof Error ? err.message : "Couldn't redeem invite link.",
        );
      } finally {
        await clearPendingInviteToken();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [controller, state.route]);

  useEffect(() => {
    if (state.route !== "ready") return;

    const openSessionFromResponse = (response: unknown) => {
      const href = notificationResponseToSessionHref(response);
      if (!href) return;
      const dedupeKey = notificationResponseDedupeKey(response) ?? href;
      if (dedupeKey === lastNotificationDedupeKeyRef.current) return;
      lastNotificationDedupeKeyRef.current = dedupeKey;
      router.push(href);
    };

    const subscription =
      Notifications.addNotificationResponseReceivedListener(openSessionFromResponse);
    void Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (response) openSessionFromResponse(response);
      })
      .catch(() => {
        // Notification response replay is best-effort.
      });

    return () => {
      subscription.remove();
    };
  }, [state.route]);

  useEffect(() => {
    if (state.route !== "ready") return;
    let cancelled = false;

    void (async () => {
      const [{ data }, deviceId] = await Promise.all([
        supabase.auth.getSession(),
        getExpoDeviceId(),
      ]);
      if (cancelled) return;
      const userId = data.session?.user.id ?? null;
      await registerNativePushToken({
        notifications: Notifications,
        api: createPushTokenApi({ getAccessToken: supabaseAccessToken(supabase) }),
        userId,
        deviceId,
        platform: Platform.OS,
        appVersion: Constants.expoConfig?.version ?? null,
      });
    })().catch(() => {
      // Push registration should not block opening the app.
    });

    return () => {
      cancelled = true;
    };
  }, [state.route]);

  useEffect(() => {
    if (state.route !== "ready") return;

    let disposed = false;
    let heartbeat: ReturnType<typeof createForegroundPresenceHeartbeat> | null = null;
    let subscription: { remove: () => void } | null = null;

    void (async () => {
      const deviceId = await getExpoDeviceId();
      if (disposed) return;

      const version = Constants.expoConfig?.version ?? null;
      const teamId = state.currentTeam?.id ?? null;
      if (version && teamId) {
        const cloudClient = createCloudApiClient({
          baseUrl: cloudApiBaseUrl(),
          getAccessToken: supabaseAccessToken(supabase),
        });
        void reportExpoClientVersion(cloudClient, teamId, { version, deviceId });
      }

      const presence = createPresenceApi({ getAccessToken: supabaseAccessToken(supabase) });
      heartbeat = createForegroundPresenceHeartbeat({
        deviceId,
        writeForeground: presence.writeForeground,
      });

      const applyState = (nextState: string) => {
        if (nextState === "active") heartbeat?.enterForeground();
        else heartbeat?.enterBackground();
      };
      applyState(AppState.currentState);
      subscription = AppState.addEventListener("change", applyState);

      if (disposed) {
        subscription.remove();
        heartbeat.dispose();
      }
    })().catch(() => {
      // Presence only suppresses duplicate push while foregrounded.
    });

    return () => {
      disposed = true;
      subscription?.remove();
      heartbeat?.dispose();
    };
  }, [state.route]);

  // The Sessions badge belongs to one team. Switching (or signing out) zeroes
  // it, and a late answer from the previous team's list is dropped.
  const activeTeamId = state.currentTeam?.id ?? null;
  useEffect(() => {
    setActiveUnreadTeam(activeTeamId);
  }, [activeTeamId]);

  // Wire up team-scoped MQTT + ConnectedAgentsStore when the user is ready.
  // Tears down and recreates automatically when the team or actor changes.
  useEffect(() => {
    if (state.route !== "ready") return;
    if (!state.currentTeam || !state.currentMemberActorId) return;

    let disposed = false;

    void (async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token ?? null;
      if (!accessToken || disposed) return;

      // Broker address comes from the Cloud API (cached across launches), so a
      // moved broker doesn't need an app release. No address → don't connect.
      const mqttUrl = await resolveMqttUrl({
        getAccessToken: supabaseAccessToken(supabase),
      });
      if (!mqttUrl || disposed) return;

      const mqtt = createTeamMqttClient({
        url: mqttUrl,
        username: state.currentMemberActorId!,
        password: accessToken,
        clientId: `teamclu-expo-${state.currentMemberActorId!.slice(0, 8)}`,
      });
      try {
        await mqtt.start();
      } catch {
        return;
      }
      if (disposed) {
        void mqtt.dispose();
        return;
      }
      teamMqttRef.current = mqtt;
      setTeamMqtt(mqtt);

      const db = await getDb();
      const cache = createConnectedAgentsCache(db as Parameters<typeof createConnectedAgentsCache>[0]);
      const subscriber = createRuntimeStateSubscriber({
        mqtt,
        teamId: state.currentTeam!.id,
        decode: decodeActorPresence,
        onPresence: (actorId, presence) =>
          connectedAgentsStoreRef.current?.handlePresence(actorId, presence),
      });
      const store = createConnectedAgentsStore({
        teamId: state.currentTeam!.id,
        api: createAgentAccessApi({ getAccessToken: supabaseAccessToken(supabase) }),
        subscriber,
        cache,
      });
      connectedAgentsStoreRef.current = store;
      if (disposed) {
        void store.dispose();
        void mqtt.dispose();
        teamMqttRef.current = null;
        connectedAgentsStoreRef.current = null;
        return;
      }
      await store.reload();
      if (!disposed) setConnectedAgentsStore(store);
    })();

    return () => {
      disposed = true;
      void connectedAgentsStoreRef.current?.dispose();
      void teamMqttRef.current?.dispose();
      connectedAgentsStoreRef.current = null;
      teamMqttRef.current = null;
      setTeamMqtt(null);
      setConnectedAgentsStore(null);
    };
  }, [state.route, state.currentTeam?.id, state.currentMemberActorId]);

  const value: OnboardingContextValue = {
    controller,
    state,
    retryBootstrap: async () => {
      await controller.bootstrap();
    },
    applyServerChange: async () => {
      let next: string;
      try {
        next = cloudApiBaseUrl();
      } catch {
        return;
      }
      const previous = activeCloudBaseUrlRef.current;
      if (previous !== null && previous !== next) {
        void connectedAgentsStoreRef.current?.dispose();
        void teamMqttRef.current?.dispose();
        connectedAgentsStoreRef.current = null;
        teamMqttRef.current = null;
        setTeamMqtt(null);
        setConnectedAgentsStore(null);
        await tearDownCloudAuthForServerSwitch(previous);
        // Clear deployment-scoped caches the old session left behind. Full
        // `controller.signOut()` would also do this, but it recreates auth
        // against the *new* URL mid-switch; local clear is enough here.
        await clearCachedMqttUrl();
        await controller.signOut();
      }
      activeCloudBaseUrlRef.current = next;
      await controller.bootstrap();
    },
  };

  if (!hydrated) {
    // Hold the tree until the override is in memory so the first bootstrap
    // (and any sync `cloudApiBaseUrl()` read) sees the right host.
    return null;
  }

  return (
    <OnboardingContext.Provider value={value}>
      <TeamMqttContext.Provider value={teamMqtt}>
        <ConnectedAgentsContext.Provider value={connectedAgentsStore}>
          {children}
        </ConnectedAgentsContext.Provider>
      </TeamMqttContext.Provider>
    </OnboardingContext.Provider>
  );
}

function RootLayout() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <StatusBar {...appStatusBarProps} />
      <OnboardingProvider>
        {/* Top only. The bottom belongs to whatever is at the bottom of the
            screen: the tab bar pads itself so it reaches the display edge,
            `SheetModal` insets its own sheets, and no other route pins content
            to the bottom. Reserving it here instead left every tabbed screen
            with a strip of Mist under the Paper tab bar — near-identical
            colours, so it read as one tall bar floating above the gesture
            pill, with the icons stuck in its top half. */}
        <SafeAreaView edges={["top"]} style={styles.safeArea}>
          <View style={styles.layout}>
            <Slot />
            <ToastHost />
          </View>
        </SafeAreaView>
      </OnboardingProvider>
    </GestureHandlerRootView>
  );
}

export default wrapRoot(RootLayout);

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  layout: {
    backgroundColor: colors.background,
    flex: 1,
  },
  safeArea: {
    backgroundColor: colors.background,
    flex: 1,
  },
});
