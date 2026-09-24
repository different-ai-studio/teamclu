import { useLocalSearchParams, useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Share } from "react-native";

import { useOnboarding, useTeamMqtt } from "../_layout";
import { createActorsApi } from "../../src/features/actors/actor-api";
import { createAgentAccessApi } from "../../src/features/actors/agent-access-api";
import {
  canManageAuthorizedHumans,
  canRemoveActor,
} from "../../src/features/actors/actor-management";
import type { Actor } from "../../src/features/actors/actor-types";
import type { AgentAuthorizedHuman } from "../../src/features/actors/connected-agent-types";
import { createLeaderboardApi } from "../../src/features/actors/leaderboard-api";
import {
  loadMemberActivityStats,
  MEMBER_TOKEN_PERIOD,
  type MemberActivityStats,
} from "../../src/features/actors/member-activity-stats";
import {
  ActorDetailScreen,
  type AgentWorkspaceChoice,
} from "../../src/features/actors/screens/ActorDetailScreen";
import {
  createTeamResourcesApi,
  type TeamResourceCounts,
} from "../../src/features/actors/team-resources-api";
import { createWorkspacesApi } from "../../src/features/workspaces/workspace-api";
import { createConfiguredSessionsApi } from "../../src/features/sessions/api-provider";
import { createIdeasApi } from "../../src/features/ideas/idea-api";
import { supabase } from "../../src/lib/supabase/client";
import { supabaseAccessToken } from "../../src/lib/cloud-api/client";
import { createRuntimeRpcClient } from "../../src/lib/teamclu/runtime-rpc";
import { showToast } from "../../src/ui/Toast";

type RecentSession = {
  sessionId: string;
  title: string;
  lastMessageAt: string;
};

export default function ActorDetailRoute() {
  const { t } = useTranslation();
  const router = useRouter();
  const { state } = useOnboarding();
  const teamMqtt = useTeamMqtt();
  const params = useLocalSearchParams<{ actorId?: string }>();
  const actorId = typeof params.actorId === "string" ? params.actorId : null;
  const teamId = state.currentTeam?.id ?? "";
  const isMe = actorId !== null && actorId === state.currentMemberActorId;

  const actorsApi = useMemo(
    () => createActorsApi({ getAccessToken: supabaseAccessToken(supabase) }),
    [],
  );
  const agentAccessApi = useMemo(
    () => createAgentAccessApi({ getAccessToken: supabaseAccessToken(supabase) }),
    [],
  );
  const workspacesApi = useMemo(
    () => createWorkspacesApi({ getAccessToken: supabaseAccessToken(supabase) }),
    [],
  );
  const teamResourcesApi = useMemo(
    () => createTeamResourcesApi({ getAccessToken: supabaseAccessToken(supabase) }),
    [],
  );

  const [actor, setActor] = useState<Actor | null>(null);
  const [agentIsOwner, setAgentIsOwner] = useState(false);
  const [allActors, setAllActors] = useState<Actor[]>([]);
  const [agentWorkspaces, setAgentWorkspaces] = useState<AgentWorkspaceChoice[]>([]);
  const [authorizedHumans, setAuthorizedHumans] = useState<AgentAuthorizedHuman[]>([]);
  const [isCreatingReinvite, setIsCreatingReinvite] = useState(false);
  const [isAddingAgentWorkspace, setIsAddingAgentWorkspace] = useState(false);
  const [isGrantingAuthorizedHuman, setIsGrantingAuthorizedHuman] = useState(false);
  const [isLoadingAuthorizedHumans, setIsLoadingAuthorizedHumans] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [isRevokingAuthorizedHuman, setIsRevokingAuthorizedHuman] = useState(false);
  const [isRemovingAgentWorkspace, setIsRemovingAgentWorkspace] = useState(false);
  const [isSavingAgentDefaults, setIsSavingAgentDefaults] = useState(false);
  const [isUpdatingAgentVisibility, setIsUpdatingAgentVisibility] = useState(false);
  const [recentSessions, setRecentSessions] = useState<RecentSession[]>([]);
  const [memberStats, setMemberStats] = useState<MemberActivityStats | null>(null);
  const [resourceCounts, setResourceCounts] = useState<TeamResourceCounts | null>(null);
  const [myDefaultAgentId, setMyDefaultAgentId] = useState<string | null>(null);
  const [isSavingMyDefaultAgent, setIsSavingMyDefaultAgent] = useState(false);
  const canRemove = canRemoveActor({
    actorId,
    currentMemberActorId: state.currentMemberActorId,
    currentTeamRole: state.currentTeam?.role,
  });
  const canManageAccess = canManageAuthorizedHumans({
    actorType: actor?.actorType,
    isOwner: agentIsOwner,
  });
  // Workspaces are the daemon's to accept, not an owner privilege: iOS offers
  // "add workspace" to anyone who can reach the agent over MQTT. Gating it on
  // `role === "owner"` hid it from everyone, because the permission endpoint
  // answers "admin" even for the member who invited the agent — so a freshly
  // invited agent could never get a workspace and no session could start on it.
  const canManageWorkspaces = actor?.actorType === "agent" && teamMqtt != null;
  const authorizedHumanIds = new Set(authorizedHumans.map((human) => human.id));
  const authorizedMemberCandidates = allActors.filter(
    (row) =>
      row.actorType === "member" &&
      row.actorId !== state.currentMemberActorId &&
      !authorizedHumanIds.has(row.actorId),
  );

  // Three concurrent reads that decorate an agent's header; a failing leg
  // reports 0 rather than blanking the screen (iOS
  // `TeamResourceRepository.counts`). A person's page draws none of them.
  useEffect(() => {
    if (!teamId || !actorId || actor?.actorType !== "agent") return;
    let cancelled = false;
    void teamResourcesApi.counts(teamId, actorId).then((counts) => {
      if (!cancelled) setResourceCounts(counts);
    });
    return () => {
      cancelled = true;
    };
  }, [actor?.actorType, actorId, teamId, teamResourcesApi]);

  // A person's equivalent: tokens this month and ideas still on the board
  // (iOS #1568). Null until loaded, so the row shows "—", not a fake zero.
  useEffect(() => {
    if (!teamId || !actorId || actor?.actorType !== "member") return;
    let cancelled = false;
    setMemberStats(null);
    const getAccessToken = supabaseAccessToken(supabase);
    void loadMemberActivityStats({
      actorId,
      loadLeaderboard: () =>
        createLeaderboardApi({ getAccessToken }).getLeaderboard(teamId, MEMBER_TOKEN_PERIOD),
      loadIdeas: () => createIdeasApi({ getAccessToken }).listIdeas(teamId),
    }).then((next) => {
      if (!cancelled) setMemberStats(next);
    });
    return () => {
      cancelled = true;
    };
  }, [actor?.actorType, actorId, teamId]);

  // `members.default_agent_id` — the viewer's own default, distinct from the
  // agent-owned defaults below and from the team-wide default in Settings.
  useEffect(() => {
    if (!teamId || actor?.actorType !== "agent") return;
    let cancelled = false;
    void actorsApi
      .getMemberDefaultAgent(teamId)
      .then((id) => {
        if (!cancelled) setMyDefaultAgentId(id);
      })
      .catch(() => {
        if (!cancelled) setMyDefaultAgentId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [actor?.actorType, actorsApi, teamId]);

  const setMyDefaultAgent = useCallback(
    async (makeDefault: boolean) => {
      if (!teamId || !actorId || isSavingMyDefaultAgent) return;
      setIsSavingMyDefaultAgent(true);
      try {
        const next = await actorsApi.setMemberDefaultAgent(
          teamId,
          makeDefault ? actorId : null,
        );
        setMyDefaultAgentId(next);
      } catch (err) {
        showToast(
          "error",
          err instanceof Error ? err.message : t("Couldn't update your default agent."),
        );
      } finally {
        setIsSavingMyDefaultAgent(false);
      }
    },
    [actorId, actorsApi, isSavingMyDefaultAgent, teamId],
  );

  const reloadAgentWorkspaces = useCallback(async () => {
    if (!teamId) return;
    try {
      const rows = await workspacesApi.list(teamId);
      setAgentWorkspaces(
        rows
          .filter((w) => !w.archived)
          .map((w) => ({ id: w.id, name: w.name, path: w.path, agentId: w.agentId }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
    } catch {
      setAgentWorkspaces([]);
    }
  }, [teamId, workspacesApi]);

  const refresh = useCallback(async () => {
    if (!teamId || !actorId) return;
    setIsRefreshing(true);
    try {
      const rows = await actorsApi.listActors(teamId);
      setAllActors(rows);
      const found = rows.find((row) => row.actorId === actorId) ?? null;
      if (found?.actorType === "agent") {
        // Directory drops owner; re-hydrate owner-gating from agent-access so it
        // survives a refresh. Daemon routing uses the actor id directly.
        const owner = state.currentMemberActorId
          ? await agentAccessApi
              .canManageAgent(actorId, state.currentMemberActorId)
              .catch(() => false)
          : false;
        setAgentIsOwner(owner);
        setActor(found);
      } else {
        setAgentIsOwner(false);
        setActor(found);
      }
    } finally {
      setIsRefreshing(false);
    }
  }, [actorId, teamId, actorsApi, agentAccessApi, state.currentMemberActorId]);

  useEffect(() => {
    if (!teamId || !actorId) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    void (async () => {
      try {
        const rows = await actorsApi.listActors(teamId);
        if (cancelled) return;
        const nextActor = rows.find((row) => row.actorId === actorId) ?? null;
        setAllActors(rows);
        setActor(nextActor);
        setAgentIsOwner(false);

        if (nextActor?.actorType === "agent") {
          setIsLoadingAuthorizedHumans(true);
          const [authorizedRows, owner, workspaceRows] = await Promise.all([
            agentAccessApi.listAuthorizedHumans(actorId),
            state.currentMemberActorId
              ? agentAccessApi
                  .canManageAgent(actorId, state.currentMemberActorId)
                  .catch(() => false)
              : Promise.resolve(false),
            workspacesApi.list(teamId).catch(() => []),
          ]);
          if (cancelled) return;
          setAuthorizedHumans(authorizedRows);
          setAgentIsOwner(owner);
          // Daemon routing uses the agent's actor id directly; no device-id merge.
          setAgentWorkspaces(
            workspaceRows
              .filter((w) => !w.archived)
              .map((w) => ({ id: w.id, name: w.name, path: w.path, agentId: w.agentId }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          );
          setIsLoadingAuthorizedHumans(false);
        } else {
          setAuthorizedHumans([]);
          setAgentWorkspaces([]);
        }

        const sessionIds = await actorsApi.listActorSessionIds(actorId);
        if (cancelled) return;
        const sessionIdSet = new Set(sessionIds);
        const teamSessions = teamId
          ? await createConfiguredSessionsApi(supabase).listSessions(teamId)
          : [];
        if (cancelled) return;
        const sessions = teamSessions
          .filter((s) => sessionIdSet.has(s.sessionId))
          .map((s) => ({
            sessionId: s.sessionId,
            title: s.title ?? "",
            lastMessageAt: s.lastMessageAt ?? "",
          }))
          .sort((a, b) => {
            const ams = Date.parse(a.lastMessageAt) || 0;
            const bms = Date.parse(b.lastMessageAt) || 0;
            return bms - ams;
          })
          .slice(0, 5);
        setRecentSessions(sessions);
      } catch {
        if (!cancelled) {
          setActor(null);
          setAllActors([]);
          setAgentWorkspaces([]);
          setAuthorizedHumans([]);
          setRecentSessions([]);
        }
      } finally {
        if (!cancelled) setIsLoadingAuthorizedHumans(false);
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actorId, teamId, actorsApi, agentAccessApi, workspacesApi, state.currentMemberActorId]);

  const reloadAuthorizedHumans = useCallback(async () => {
    if (!actorId || actor?.actorType !== "agent") return;
    setIsLoadingAuthorizedHumans(true);
    try {
      const rows = await agentAccessApi.listAuthorizedHumans(actorId);
      setAuthorizedHumans(rows);
      } catch (err) {
        showToast(
          "error",
          err instanceof Error ? err.message : t("Couldn't load authorized members."),
        );
    } finally {
      setIsLoadingAuthorizedHumans(false);
    }
  }, [actor?.actorType, actorId, agentAccessApi]);

  const removeActor = useCallback(() => {
    if (!actorId || !actor || isRemoving) return;
    Alert.alert(
      t("Remove actor"),
      t("Remove {{value}} from the team?", { value: actor.displayName }),
      [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Remove"),
          style: "destructive",
          onPress: () => {
            setIsRemoving(true);
            void actorsApi
              .removeActor(actorId)
              .then(() => {
                showToast("success", t("Actor removed from team."));
                router.back();
              })
              .catch((err) => {
                showToast(
                  "error",
                  err instanceof Error ? err.message : t("Couldn't remove actor."),
                );
              })
              .finally(() => {
                setIsRemoving(false);
              });
          },
        },
      ],
    );
  }, [actor, actorId, actorsApi, isRemoving, router, t]);

  const createReinvite = useCallback(async () => {
    if (!teamId || !actor || isCreatingReinvite) return;
    setIsCreatingReinvite(true);
    try {
      const invite = await actorsApi.createReinvite({ teamId, actor });
      await Clipboard.setStringAsync(invite.deeplink);
      showToast("success", t("Invite link copied."));
      await Share.share({ message: invite.deeplink });
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : t("Couldn't create invite link."),
      );
    } finally {
      setIsCreatingReinvite(false);
    }
  }, [actor, actorsApi, isCreatingReinvite, teamId]);

  const grantAuthorizedHuman = useCallback(
    async (memberActorId: string) => {
      if (!actorId || !state.currentMemberActorId || isGrantingAuthorizedHuman) return;
      setIsGrantingAuthorizedHuman(true);
      try {
        await agentAccessApi.grantAuthorizedHuman(
          actorId,
          memberActorId,
          "prompt",
          state.currentMemberActorId,
        );
        showToast("success", t("Member authorized."));
        await reloadAuthorizedHumans();
      } catch (err) {
        showToast(
          "error",
          err instanceof Error ? err.message : t("Couldn't authorize member."),
        );
      } finally {
        setIsGrantingAuthorizedHuman(false);
      }
    },
    [
      actorId,
      agentAccessApi,
      isGrantingAuthorizedHuman,
      reloadAuthorizedHumans,
      state.currentMemberActorId,
    ],
  );

  const revokeAuthorizedHuman = useCallback(
    async (memberActorId: string) => {
      if (!actorId || isRevokingAuthorizedHuman) return;
      setIsRevokingAuthorizedHuman(true);
      try {
        await agentAccessApi.revokeAuthorizedHuman(actorId, memberActorId);
        showToast("success", t("Member access revoked."));
        await reloadAuthorizedHumans();
      } catch (err) {
        showToast(
          "error",
          err instanceof Error ? err.message : t("Couldn't revoke member access."),
        );
      } finally {
        setIsRevokingAuthorizedHuman(false);
      }
    },
    [actorId, agentAccessApi, isRevokingAuthorizedHuman, reloadAuthorizedHumans],
  );

  const updateAgentDefaults = useCallback(
    async (patch: { defaultWorkspaceId?: string | null; defaultAgentType?: string | null }) => {
      if (!actorId || !actor || isSavingAgentDefaults) return;
      setIsSavingAgentDefaults(true);
      try {
        await actorsApi.updateAgentDefaults(actorId, patch);
        setActor((prev) =>
          prev?.actorId === actorId
            ? {
                ...prev,
                defaultWorkspaceId:
                  patch.defaultWorkspaceId === undefined
                    ? prev.defaultWorkspaceId
                    : patch.defaultWorkspaceId,
                defaultAgentType:
                  patch.defaultAgentType === undefined
                    ? prev.defaultAgentType
                    : patch.defaultAgentType,
                agentKind:
                  patch.defaultAgentType === undefined
                    ? prev.agentKind
                    : patch.defaultAgentType,
              }
            : prev,
        );
        showToast("success", t("Agent defaults saved."));
      } catch (err) {
        showToast(
          "error",
          err instanceof Error ? err.message : t("Couldn't save agent defaults."),
        );
      } finally {
        setIsSavingAgentDefaults(false);
      }
    },
    [actor, actorId, actorsApi, isSavingAgentDefaults],
  );

  const addAgentWorkspace = useCallback(
    async (path: string) => {
      if (actor?.actorType !== "agent" || !actor?.actorId || !teamMqtt || !teamId || !state.currentMemberActorId) {
        showToast("error", t("Daemon routing is unavailable."));
        return;
      }
      if (isAddingAgentWorkspace) return;
      setIsAddingAgentWorkspace(true);
      try {
        const rpc = createRuntimeRpcClient({
          mqtt: teamMqtt,
          teamId,
          requesterActorId: state.currentMemberActorId,
        });
        await rpc.addWorkspace({
          targetActorId: actor.actorId,
          path,
          timeoutMs: 25_000,
        });
        showToast("success", t("Workspace add requested."));
        await Promise.all([refresh(), reloadAgentWorkspaces()]);
      } catch (err) {
        showToast(
          "error",
          err instanceof Error ? err.message : t("Couldn't add workspace."),
        );
      } finally {
        setIsAddingAgentWorkspace(false);
      }
    },
    [
      actor?.actorType,
      actor?.actorId,
      isAddingAgentWorkspace,
      reloadAgentWorkspaces,
      refresh,
      state.currentMemberActorId,
      teamId,
      teamMqtt,
    ],
  );

  const removeAgentWorkspace = useCallback(
    async (workspaceId: string) => {
      if (actor?.actorType !== "agent" || !actor?.actorId || !teamMqtt || !teamId || !state.currentMemberActorId) {
        showToast("error", t("Daemon routing is unavailable."));
        return;
      }
      if (isRemovingAgentWorkspace) return;
      setIsRemovingAgentWorkspace(true);
      try {
        // The cloud row is what lists the workspace, and the daemon no longer
        // owns it: its `remove_workspace` answers success and does nothing
        // ("WorkspaceStore removed; cloud archive not yet implemented"), so
        // the row stayed and the trash button looked broken. Archive it here;
        // the daemon is told afterwards so it can drop anything it caches.
        await workspacesApi.setArchived(workspaceId, true);
        const rpc = createRuntimeRpcClient({
          mqtt: teamMqtt,
          teamId,
          requesterActorId: state.currentMemberActorId,
        });
        void rpc
          .removeWorkspace({ targetActorId: actor.actorId, workspaceId, timeoutMs: 25_000 })
          .catch(() => {});
        showToast("success", t("Workspace remove requested."));
        await Promise.all([refresh(), reloadAgentWorkspaces()]);
      } catch (err) {
        showToast(
          "error",
          err instanceof Error ? err.message : t("Couldn't remove workspace."),
        );
      } finally {
        setIsRemovingAgentWorkspace(false);
      }
    },
    [
      actor?.actorType,
      actor?.actorId,
      isRemovingAgentWorkspace,
      reloadAgentWorkspaces,
      refresh,
      state.currentMemberActorId,
      teamId,
      teamMqtt,
      workspacesApi,
    ],
  );

  const updateAgentVisibility = useCallback(
    async (visibility: "team" | "personal") => {
      if (!actorId || !actor || isUpdatingAgentVisibility) return;
      setIsUpdatingAgentVisibility(true);
      try {
        if (visibility === "team") {
          await agentAccessApi.shareAgentToTeam(actorId);
        } else {
          await agentAccessApi.makeAgentPersonal(actorId);
        }
        setActor((prev) => (prev?.actorId === actorId ? { ...prev, visibility } : prev));
        showToast(
          "success",
          visibility === "team" ? t("Agent shared to team.") : t("Agent made personal."),
        );
        await refresh();
      } catch (err) {
        showToast(
          "error",
          err instanceof Error ? err.message : t("Couldn't update agent visibility."),
        );
      } finally {
        setIsUpdatingAgentVisibility(false);
      }
    },
    [actor, actorId, agentAccessApi, isUpdatingAgentVisibility, refresh],
  );

  return (
    <ActorDetailScreen
      actor={actor}
      agentWorkspaces={agentWorkspaces}
      authorizedHumans={authorizedHumans}
      authorizedMemberCandidates={authorizedMemberCandidates}
      isLoading={isLoading}
      isAddingAgentWorkspace={isAddingAgentWorkspace}
      isCreatingReinvite={isCreatingReinvite}
      isGrantingAuthorizedHuman={isGrantingAuthorizedHuman}
      isLoadingAuthorizedHumans={isLoadingAuthorizedHumans}
      isMe={isMe}
      isMyDefaultAgent={actorId !== null && myDefaultAgentId === actorId}
      isRefreshing={isRefreshing}
      isRemoving={isRemoving}
      isRemovingAgentWorkspace={isRemovingAgentWorkspace}
      isRevokingAuthorizedHuman={isRevokingAuthorizedHuman}
      isSavingAgentDefaults={isSavingAgentDefaults}
      isSavingMyDefaultAgent={isSavingMyDefaultAgent}
      isUpdatingAgentVisibility={isUpdatingAgentVisibility}
      onClose={() => router.back()}
      onAddAgentWorkspace={canManageWorkspaces ? addAgentWorkspace : undefined}
      onCreateReinvite={canRemove ? createReinvite : undefined}
      onGrantAuthorizedHuman={canManageAccess ? grantAuthorizedHuman : undefined}
      onMakeAgentPersonal={
        canManageAccess && actor?.visibility !== "personal"
          ? () => void updateAgentVisibility("personal")
          : undefined
      }
      onRefresh={() => {
        void Promise.all([refresh(), reloadAuthorizedHumans()]);
      }}
      onRemoveActor={canRemove ? removeActor : undefined}
      onRemoveAgentWorkspace={canManageWorkspaces ? removeAgentWorkspace : undefined}
      onRevokeAuthorizedHuman={canManageAccess ? revokeAuthorizedHuman : undefined}
      onSetMyDefaultAgent={
        actor?.actorType === "agent"
          ? (makeDefault) => void setMyDefaultAgent(makeDefault)
          : undefined
      }
      onSelectResource={
        actorId
          ? (kind) => {
              const name = encodeURIComponent(actor?.displayName ?? t("This actor"));
              router.push(
                `/(app)/actor-resources?actorId=${encodeURIComponent(actorId)}&actorName=${name}&kind=${kind}`,
              );
            }
          : undefined
      }
      onSelectSession={(sessionId) => {
        router.replace(`/(app)/sessions/${sessionId}`);
      }}
      onShareAgentToTeam={
        canManageAccess && actor?.visibility === "personal"
          ? () => void updateAgentVisibility("team")
          : undefined
      }
      onUpdateAgentDefaults={actor?.actorType === "agent" ? updateAgentDefaults : undefined}
      recentSessions={recentSessions}
      resourceCounts={resourceCounts}
      memberStats={memberStats}
      onOpenMemberIdeas={
        actorId
          ? () => {
              const name = encodeURIComponent(actor?.displayName ?? t("This actor"));
              router.push(
                `/(app)/actor-ideas?actorId=${encodeURIComponent(actorId)}&actorName=${name}`,
              );
            }
          : undefined
      }
    />
  );
}
