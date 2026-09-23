import Constants from "expo-constants";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActionSheetIOS, Alert, Platform } from "react-native";

import { useOnboarding } from "../_layout";
import { createActorsApi } from "../../src/features/actors/actor-api";
import { createAgentAccessApi } from "../../src/features/actors/agent-access-api";
import type { ConnectedAgent } from "../../src/features/actors/connected-agent-types";
import {
  createNotificationPrefsApi,
  defaultNotificationPrefs,
  type NotificationPrefs,
} from "../../src/features/notifications/notification-prefs-api";
import {
  SettingsScreen,
  type SettingsTeamDetails,
} from "../../src/features/settings/screens/SettingsScreen";
import { createConfiguredInviteApi } from "../../src/features/onboarding/invite-api";
import { createTeamsApi } from "../../src/features/teams/teams-api";
import { cloudApiBaseUrl, supabaseAccessToken } from "../../src/lib/cloud-api/client";
import { getKnownMqttUrl } from "../../src/lib/mqtt/config";
import { supabase } from "../../src/lib/supabase/client";
import { showToast } from "../../src/ui/Toast";

/** Owner/admin can write the team default agent; everyone else reads it. */
function canEditTeamDefault(role: string | null | undefined): boolean {
  const normalized = role?.toLowerCase();
  return normalized === "owner" || normalized === "admin";
}

export default function SettingsRoute() {
  const router = useRouter();
  const { t } = useTranslation();
  const { state } = useOnboarding();
  const teamId = state.currentTeam?.id ?? "";
  const currentActorId = state.currentMemberActorId;

  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [pushPrefs, setPushPrefs] = useState<NotificationPrefs>(defaultNotificationPrefs);
  const [profile, setProfile] = useState<{ displayName: string; avatarUrl: string | null } | null>(
    null,
  );
  const [teamDetails, setTeamDetails] = useState<SettingsTeamDetails | null>(null);
  const [teamDetailsError, setTeamDetailsError] = useState<string | null>(null);
  const [agents, setAgents] = useState<ConnectedAgent[]>([]);
  const [isLoadingAgents, setIsLoadingAgents] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [teamDefaultAgentId, setTeamDefaultAgentId] = useState<string | null>(null);
  const [isSavingTeamDefaultAgent, setIsSavingTeamDefaultAgent] = useState(false);
  const [teamDefaultAgentError, setTeamDefaultAgentError] = useState<string | null>(null);

  const actorsApi = useMemo(
    () => createActorsApi({ getAccessToken: supabaseAccessToken(supabase) }),
    [],
  );
  const agentAccessApi = useMemo(
    () => createAgentAccessApi({ getAccessToken: supabaseAccessToken(supabase) }),
    [],
  );
  const teamsApi = useMemo(
    () => createTeamsApi({ getAccessToken: supabaseAccessToken(supabase) }),
    [],
  );
  const pushPrefsApi = useMemo(
    () => createNotificationPrefsApi({ getAccessToken: supabaseAccessToken(supabase) }),
    [],
  );
  const inviteApi = useMemo(() => createConfiguredInviteApi(supabase), []);
  const [pendingInviteCount, setPendingInviteCount] = useState(0);

  // Refreshed on every focus, so declining in the invites sheet updates the
  // badge on return. A failure reads as none (iOS `refreshPendingInvites`).
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void inviteApi
        .listPending()
        .then((rows) => {
          if (!cancelled) setPendingInviteCount(rows.length);
        })
        .catch(() => {
          if (!cancelled) setPendingInviteCount(0);
        });
      return () => {
        cancelled = true;
      };
    }, [inviteApi]),
  );

  useEffect(() => {
    let cancelled = false;
    void supabase.auth.getUser().then(({ data }) => {
      if (cancelled) return;
      setUserEmail(data.user?.email ?? null);
    });
    // The Settings push switch is the same server-side master toggle the
    // Notifications screen edits — reading it here keeps the two in step
    // instead of showing a switch that forgets on close.
    void pushPrefsApi
      .load()
      .then((prefs) => {
        if (!cancelled) setPushPrefs(prefs);
      })
      .catch(() => {
        // Keep defaults; the Notifications screen surfaces the failure.
      });
    return () => {
      cancelled = true;
    };
  }, [pushPrefsApi]);

  // Identity card: the actor directory owns the display name and avatar. The
  // email local-part is only a fallback for a guest with no directory row yet.
  useEffect(() => {
    if (!teamId || !currentActorId) return;
    let cancelled = false;
    void actorsApi
      .listActors(teamId)
      .then((rows) => {
        if (cancelled) return;
        const me = rows.find((row) => row.actorId === currentActorId);
        if (me) setProfile({ displayName: me.displayName, avatarUrl: me.avatarUrl });
        // iOS leaves ownerDisplayName nil on the wire; resolve it from the
        // directory so the Team card can actually name the owner.
        const owner = rows.find(
          (row) => row.actorType === "member" && row.role?.toLowerCase() === "owner",
        );
        if (owner) {
          setTeamDetails((prev) =>
            prev ? { ...prev, ownerDisplayName: owner.displayName } : prev,
          );
        }
      })
      .catch(() => {
        if (!cancelled) setProfile(null);
      });
    return () => {
      cancelled = true;
    };
  }, [actorsApi, currentActorId, teamId]);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    void teamsApi
      .loadDetails(teamId)
      .then((details) => {
        if (cancelled) return;
        setTeamDetails((prev) => ({
          createdAt: details.createdAt,
          orgName: details.orgName,
          // Preserve an owner name the directory pass may already have resolved.
          ownerDisplayName: prev?.ownerDisplayName ?? details.ownerDisplayName,
        }));
        setTeamDetailsError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setTeamDetailsError(
          err instanceof Error ? err.message : t("Couldn't load team details."),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, teamsApi]);

  const reloadAgents = useCallback(async () => {
    if (!teamId) return;
    setIsLoadingAgents(true);
    try {
      setAgents(await agentAccessApi.listConnectedAgents(teamId));
      setAgentsError(null);
    } catch (err) {
      setAgentsError(err instanceof Error ? err.message : t("Couldn't load agents."));
    } finally {
      setIsLoadingAgents(false);
    }
  }, [agentAccessApi, teamId]);

  useEffect(() => {
    void reloadAgents();
  }, [reloadAgents]);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    void actorsApi
      .getTeamDefaultAgent(teamId)
      .then((id) => {
        if (!cancelled) setTeamDefaultAgentId(id);
      })
      .catch(() => {
        if (!cancelled) setTeamDefaultAgentId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [actorsApi, teamId]);

  const personalAgents = agents.filter((agent) => agent.visibility === "personal");
  const teamAgents = agents.filter((agent) => agent.visibility === "team");

  const displayName =
    profile?.displayName ?? userEmail?.split("@")[0] ?? "You";
  const appVersion = (Constants.expoConfig?.version as string | undefined) ?? "—";
  const buildNumber =
    (Constants.expoConfig?.runtimeVersion as string | undefined) ?? "—";

  const cloudApiAddress = (() => {
    try {
      return cloudApiBaseUrl();
    } catch {
      // Missing EXPO_PUBLIC_CLOUD_API_URL — About should say so, not crash.
      return "—";
    }
  })();

  const applyTeamDefaultAgent = async (agentId: string | null) => {
    if (!teamId || isSavingTeamDefaultAgent) return;
    const previous = teamDefaultAgentId;
    setTeamDefaultAgentId(agentId);
    setIsSavingTeamDefaultAgent(true);
    setTeamDefaultAgentError(null);
    try {
      setTeamDefaultAgentId(await actorsApi.setTeamDefaultAgent(teamId, agentId));
    } catch (err) {
      setTeamDefaultAgentId(previous);
      setTeamDefaultAgentError(
        err instanceof Error ? err.message : t("Couldn't set the team default agent."),
      );
    } finally {
      setIsSavingTeamDefaultAgent(false);
    }
  };

  const pickTeamDefaultAgent = () => {
    const options = [{ label: t("Not set"), id: null as string | null }].concat(
      teamAgents.map((agent) => ({ label: agent.displayName, id: agent.agentId })),
    );
    const labels = [...options.map((option) => option.label), t("Cancel")];
    const dispatch = (index: number) => {
      const option = options[index];
      if (!option) return;
      void applyTeamDefaultAgent(option.id);
    };
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: labels, cancelButtonIndex: options.length },
        dispatch,
      );
      return;
    }
    Alert.alert(t("Team default agent"), undefined, [
      ...options.map((option, index) => ({
        text: option.label,
        onPress: () => dispatch(index),
      })),
      { text: t("Cancel"), style: "cancel" as const },
    ]);
  };

  const togglePush = async (enabled: boolean) => {
    const previous = pushPrefs;
    const next = { ...pushPrefs, enabled };
    setPushPrefs(next);
    try {
      await pushPrefsApi.save(next);
    } catch (err) {
      setPushPrefs(previous);
      showToast(
        "error",
        err instanceof Error ? err.message : t("Couldn't save notification prefs"),
      );
    }
  };

  const handleSignOut = () => {
    Alert.alert(
      t("Sign out"),
      t("You'll need to verify your email again next time."),
      [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Sign out"),
          style: "destructive",
          onPress: async () => {
            setIsSigningOut(true);
            await supabase.auth.signOut();
            setIsSigningOut(false);
            router.replace("/");
          },
        },
      ],
    );
  };

  return (
    <SettingsScreen
      appVersion={appVersion}
      avatarUrl={profile?.avatarUrl ?? null}
      buildNumber={buildNumber}
      canEditTeamDefaultAgent={canEditTeamDefault(state.currentTeam?.role)}
      cloudApiAddress={cloudApiAddress}
      connectedAgents={personalAgents}
      connectedAgentsError={agentsError}
      currentActorId={currentActorId}
      displayName={displayName}
      isLoadingConnectedAgents={isLoadingAgents}
      isSavingTeamDefaultAgent={isSavingTeamDefaultAgent}
      isSigningOut={isSigningOut}
      mqttBrokerAddress={getKnownMqttUrl() ?? "—"}
      notificationsEnabled={pushPrefs.enabled}
      onClose={() => router.back()}
      onEditProfile={() => router.push("/(app)/edit-profile")}
      onOpenNotifications={() => router.push("/(app)/notifications")}
      onOpenTeams={() => router.push("/(app)/teams")}
      onOpenPendingInvites={() => router.push("/(app)/pending-invites")}
      onSwitchTeam={() => router.push("/(app)/switch-team")}
      pendingInviteCount={pendingInviteCount}
      onOpenWorkspaces={() => router.push("/(app)/workspaces")}
      onPickTeamDefaultAgent={pickTeamDefaultAgent}
      onShareAgentToTeam={(agentId) => {
        void (async () => {
          try {
            await agentAccessApi.shareAgentToTeam(agentId);
            await reloadAgents();
            showToast("success", t("Agent shared to team."));
          } catch (err) {
            showToast(
              "error",
              err instanceof Error ? err.message : t("Couldn't share the agent."),
            );
          }
        })();
      }}
      onSignOut={handleSignOut}
      onToggleNotifications={(enabled) => {
        void togglePush(enabled);
      }}
      team={
        state.currentTeam
          ? {
              id: state.currentTeam.id,
              name: state.currentTeam.name,
              role: state.currentTeam.role ?? null,
            }
          : null
      }
      teamAgents={teamAgents}
      teamDefaultAgentError={teamDefaultAgentError}
      teamDefaultAgentId={teamDefaultAgentId}
      teamDetails={teamDetails}
      teamDetailsError={teamDetailsError}
      userEmail={userEmail}
    />
  );
}
