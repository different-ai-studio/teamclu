import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConnectedAgentsStore, useOnboarding, useTeamMqtt } from "../_layout";
import { createActorsApi } from "../../src/features/actors/actor-api";
import { isAgentActor, type Actor } from "../../src/features/actors/actor-types";
import type { RuntimeInfo } from "../../src/features/actors/connected-agent-types";
import {
  agentBackendDisplayName,
  agentLifecycleState,
  canChangeAgentModel,
  runtimeStatusName,
} from "../../src/features/sessions/agent-runtime-state";
import {
  resolveAgentRuntimeRestartPlan,
  resolveAgentRuntimeStartPlans,
} from "../../src/features/sessions/runtime-start";
import { createConfiguredSessionsApi } from "../../src/features/sessions/api-provider";
import type { SessionParticipantRecord } from "../../src/features/sessions/cloud-api";
import { createWorkspacesApi } from "../../src/features/workspaces/workspace-api";
import { MemberPickerSheet } from "../../src/features/sessions/screens/MemberPickerSheet";
import {
  SessionMemberSheet,
  type MemberSheetAgent,
  type MemberSheetHuman,
} from "../../src/features/sessions/screens/SessionMemberSheet";
import { supabase } from "../../src/lib/supabase/client";
import { supabaseAccessToken } from "../../src/lib/cloud-api/client";
import { createRuntimeRpcClient } from "../../src/lib/teamclu/runtime-rpc";
import { showToast } from "../../src/ui/Toast";
import { ModelPickerSheet } from "../../src/features/sessions/screens/ModelPickerSheet";
import { SheetModal } from "../../src/ui/SheetModal";

type AddMode = "all" | "members" | "agents";

type WorkspaceRow = {
  id: string;
  path: string | null;
  agent_id: string | null;
};

export default function SessionMembersRoute() {
  const { t } = useTranslation();
  const router = useRouter();
  const { state } = useOnboarding();
  const teamMqtt = useTeamMqtt();
  const connectedAgentsStore = useConnectedAgentsStore();
  const params = useLocalSearchParams<{ sessionId?: string }>();
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
  const teamId = state.currentTeam?.id ?? "";

  const [actors, setActors] = useState<Actor[]>([]);
  const [participants, setParticipants] = useState<SessionParticipantRecord[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [addMode, setAddMode] = useState<AddMode | null>(null);
  const [modelPickerActorId, setModelPickerActorId] = useState<string | null>(null);
  const [runtimeByAgentId, setRuntimeByAgentId] = useState<
    ReadonlyMap<string, RuntimeInfo>
  >(new Map());

  // Live runtime facts — status, current model, the model list the picker
  // offers — arrive as retained `ActorPresence` over MQTT (ADR-0004). They used
  // to come from `agent_runtimes`, which was dropped on 2026-08-03.
  useEffect(() => {
    if (!connectedAgentsStore) return;
    setRuntimeByAgentId(connectedAgentsStore.getState().runtimeInfoByAgentId);
    const unsubscribe = connectedAgentsStore.subscribe(() => {
      setRuntimeByAgentId(connectedAgentsStore.getState().runtimeInfoByAgentId);
    });
    void connectedAgentsStore.reload();
    return unsubscribe;
  }, [connectedAgentsStore]);

  const loadParticipants = useCallback(async () => {
    if (!teamId || !sessionId) {
      setIsLoading(false);
      return;
    }
    const sessionsApi = createConfiguredSessionsApi(supabase);
    const actorsApi = createActorsApi({ getAccessToken: supabaseAccessToken(supabase) });
    const workspacesApi = createWorkspacesApi({
      getAccessToken: supabaseAccessToken(supabase),
    });
    // Settled, not all: a failing workspace list must not blank the roster.
    // The previous `Promise.all` cleared every piece of state when any one leg
    // rejected, and one leg was a 404 endpoint, so the sheet was always empty.
    const [participantsResult, actorsResult, workspacesResult] =
      await Promise.allSettled([
        sessionsApi.listSessionParticipants(sessionId),
        actorsApi.listActors(teamId),
        workspacesApi.list(teamId),
      ]);
    if (participantsResult.status === "fulfilled") {
      setParticipants(participantsResult.value);
    }
    if (actorsResult.status === "fulfilled") {
      setActors(actorsResult.value);
    }
    if (workspacesResult.status === "fulfilled") {
      setWorkspaces(
        workspacesResult.value
          .filter((row) => !row.archived)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((row) => ({ id: row.id, path: row.path, agent_id: row.agentId })),
      );
    }
    if (participantsResult.status === "rejected") {
      showToast(
        "error",
        participantsResult.reason instanceof Error
          ? participantsResult.reason.message
          : t("Couldn't load participants"),
      );
    }
  }, [sessionId, teamId, t]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    void loadParticipants().finally(() => {
      if (!cancelled) setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [loadParticipants]);

  const actorById = useMemo(
    () => new Map(actors.map((actor) => [actor.actorId, actor])),
    [actors],
  );

  const humans: MemberSheetHuman[] = useMemo(() => {
    const currentActorId = state.currentMemberActorId ?? "";
    return participants
      .filter((row) => row.actorType !== "agent")
      .map((row) => ({
        actorId: row.actorId,
        displayName: row.displayName || actorById.get(row.actorId)?.displayName || t("Member"),
        isOnline: true,
        canRemove: Boolean(currentActorId) && row.actorId !== currentActorId,
      }));
  }, [actorById, participants, state.currentMemberActorId, t]);

  const agents: MemberSheetAgent[] = useMemo(() => {
    return participants
      .filter((row) => row.actorType === "agent")
      .map((row) => {
        const runtime = runtimeByAgentId.get(row.actorId);
        const actor = actorById.get(row.actorId);
        const state = agentLifecycleState({
          status: runtimeStatusName(runtime?.status),
          lastSeenAtMs: actor?.lastActiveAt
            ? Date.parse(actor.lastActiveAt) || null
            : null,
        });
        return {
          actorId: row.actorId,
          displayName: row.displayName || actor?.displayName || t("Agent"),
          agentType: agentBackendDisplayName(
            actor?.defaultAgentType ?? actor?.agentTypes?.[0] ?? null,
          ),
          state,
          availableModels: runtime?.availableModels ?? [],
          // The participant row is authoritative for this session (ADR-0005);
          // the runtime's own value is the live fallback before the row syncs.
          currentModel: row.model ?? runtime?.currentModel ?? null,
        };
      });
  }, [actorById, participants, runtimeByAgentId, t]);

  const participantIds = useMemo(
    () => participants.map((row) => row.actorId),
    [participants],
  );

  const pickerCandidates = useMemo(() => {
    if (!addMode) return [] as Actor[];
    if (addMode === "members") return actors.filter((actor) => actor.actorType === "member");
    if (addMode === "agents") return actors.filter(isAgentActor);
    return actors;
  }, [actors, addMode]);

  const modelPickerAgent = useMemo(
    () => agents.find((agent) => agent.actorId === modelPickerActorId) ?? null,
    [agents, modelPickerActorId],
  );

  const handleRemove = async (actorId: string) => {
    if (!sessionId) return;
    try {
      await createConfiguredSessionsApi(supabase).removeParticipant(sessionId, actorId);
      setParticipants((prev) => prev.filter((row) => row.actorId !== actorId));
      showToast("success", t("Removed from session"));
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : t("Couldn't remove participant"),
      );
    }
  };

  const handleAdd = async (picked: string[]) => {
    if (!sessionId || !teamId) {
      setAddMode(null);
      return;
    }
    const fresh = picked.filter((id) => !participantIds.includes(id));
    if (fresh.length === 0) {
      setAddMode(null);
      return;
    }
    try {
      const freshAgents = fresh
        .map((id) => actorById.get(id))
        .filter((actor): actor is Actor => Boolean(actor && isAgentActor(actor)));
      if (freshAgents.length > 0 && !state.currentMemberActorId) {
        throw new Error(t("Couldn't resolve your member identity in this team."));
      }
      if (freshAgents.length > 0 && !teamMqtt) {
        throw new Error(t("MQTT is not connected — wait for TeamClu to reconnect."));
      }
      if (freshAgents.length > 0 && !connectedAgentsStore) {
        throw new Error(t("Connected agents are not ready — wait for TeamClu to reconnect."));
      }
      if (freshAgents.length > 0) {
        await connectedAgentsStore?.reload();
      }
      const runtimePlans =
        freshAgents.length > 0
          ? resolveAgentRuntimeStartPlans({
              agents: freshAgents.map((actor) => ({
                actorId: actor.actorId,
                displayName: actor.displayName,
                agentTypes: actor.agentTypes,
                defaultAgentType: actor.defaultAgentType,
                defaultWorkspaceId: actor.defaultWorkspaceId ?? null,
              })),
              connectedAgents:
                connectedAgentsStore?.getState().agents.map((agent) => ({
                  agentId: agent.agentId,
                })) ?? [],
              workspaces: workspaces.map((workspace) => ({
                id: workspace.id,
                path: workspace.path ?? "",
                agentId: workspace.agent_id,
              })),
            })
          : [];
      await createConfiguredSessionsApi(supabase).addParticipants(sessionId, fresh);
      await loadParticipants();
      if (runtimePlans.length > 0 && teamMqtt && state.currentMemberActorId) {
        const runtimeRpc = createRuntimeRpcClient({
          mqtt: teamMqtt,
          teamId,
          requesterActorId: state.currentMemberActorId,
        });
        for (const plan of runtimePlans) {
          const actorName =
            actorById.get(plan.agentActorId)?.displayName ?? t("Agent");
          void runtimeRpc.runtimeStart({
            targetActorId: plan.targetActorId,
            workspaceId: plan.workspaceId,
            worktree: plan.worktree,
            sessionId,
            agentType: plan.agentType,
            initialPrompt: "",
          }).catch((err) => {
            showToast(
              "error",
              err instanceof Error
                ? t("Couldn't start {{value}}: {{message}}", { value: actorName, message: err.message })
                : t("Couldn't start {{value}}.", { value: actorName }),
            );
          });
        }
      }
      showToast(
        "success",
        fresh.length === 1
          ? t("Added to session")
          : t("Added {{count}} to session", { count: fresh.length }),
      );
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : t("Couldn't add participants"),
      );
    } finally {
      setAddMode(null);
    }
  };

  const handleChangeModel = (actorId: string) => {
    const agent = agents.find((row) => row.actorId === actorId);
    if (
      !agent ||
      !canChangeAgentModel({
        availableModels: agent.availableModels,
        state: agent.state,
      })
    ) {
      showToast(
        "error",
        t("This agent's runtime isn't reporting models — wait for it to reconnect."),
      );
      return;
    }
    setModelPickerActorId(actorId);
  };

  const handlePickModel = async (modelId: string) => {
    const actorId = modelPickerActorId;
    setModelPickerActorId(null);
    if (!actorId || !teamId) return;
    const runtime = runtimeByAgentId.get(actorId);
    const currentMemberActorId = state.currentMemberActorId;
    if (!runtime?.runtimeId || !teamMqtt || !currentMemberActorId) {
      showToast("error", t("This agent's runtime isn't online."));
      return;
    }
    try {
      await createRuntimeRpcClient({
        mqtt: teamMqtt,
        teamId,
        requesterActorId: currentMemberActorId,
      }).setModel({
        targetActorId: actorId,
        runtimeId: runtime.runtimeId,
        modelId,
      });
      // The daemon republishes the retained runtime state with the new model,
      // so the row updates itself; reflect it now so the sheet doesn't lag.
      setParticipants((prev) =>
        prev.map((row) => (row.actorId === actorId ? { ...row, model: modelId } : row)),
      );
      showToast("success", t("Model set to {{value}}", { value: modelId }));
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : t("Couldn't set model"));
    }
  };

  const handleRestart = (actorId: string) => {
    const actor = actorById.get(actorId);
    if (!actor || !isAgentActor(actor)) {
      showToast("error", t("Couldn't resolve this agent."));
      return;
    }
    const runtime = runtimeByAgentId.get(actorId);
    const currentMemberActorId = state.currentMemberActorId;
    if (!sessionId || !teamId || !currentMemberActorId) {
      showToast("error", t("Session or member identity is not ready."));
      return;
    }
    if (!teamMqtt) {
      showToast("error", t("MQTT is not connected — wait for TeamClu to reconnect."));
      return;
    }

    void (async () => {
      try {
        await connectedAgentsStore?.reload();
        const participantRow = participants.find((row) => row.actorId === actorId);
        const plan = resolveAgentRuntimeRestartPlan({
          agent: {
            actorId: actor.actorId,
            displayName: actor.displayName,
            agentTypes: actor.agentTypes,
            defaultAgentType: actor.defaultAgentType,
            defaultWorkspaceId: actor.defaultWorkspaceId ?? null,
          },
          runtime: {
            agentId: actorId,
            runtimeId: runtime?.runtimeId ?? "",
            // The participant row owns the workspace for this session
            // (ADR-0005) and outranks whatever the live runtime happens to
            // hold, which may be from a different session.
            workspaceId: participantRow?.workspaceId ?? runtime?.workspaceId ?? null,
            backendType: actor.defaultAgentType ?? null,
          },
          connectedAgents:
            connectedAgentsStore?.getState().agents.map((agent) => ({
              agentId: agent.agentId,
            })) ?? [],
          workspaces: workspaces.map((workspace) => ({
            id: workspace.id,
            path: workspace.path ?? "",
            agentId: workspace.agent_id,
          })),
        });
        const runtimeRpc = createRuntimeRpcClient({
          mqtt: teamMqtt,
          teamId,
          requesterActorId: currentMemberActorId,
        });

        if (plan.runtimeIdToStop) {
          await runtimeRpc.runtimeStop({
            targetActorId: plan.targetActorId,
            runtimeId: plan.runtimeIdToStop,
          }).catch(() => {
            // Stop is best-effort; a stale runtime id should not block the fresh start.
          });
        }

        await runtimeRpc.runtimeStart({
          targetActorId: plan.targetActorId,
          workspaceId: plan.workspaceId,
          worktree: plan.worktree,
          sessionId,
          agentType: plan.agentType,
          initialPrompt: "",
          resetBackendBinding: true,
        });
        showToast("success", t("Runtime restart requested"));
      } catch (err) {
        showToast(
          "error",
          err instanceof Error ? err.message : t("Couldn't restart runtime"),
        );
      }
    })();
  };

  return (
    <>
      <SessionMemberSheet
        agents={agents}
        humans={humans}
        isLoading={isLoading}
        onAddAgent={() => setAddMode("agents")}
        onAddMember={() => setAddMode("members")}
        onChangeAgentModel={handleChangeModel}
        onClose={() => router.back()}
        onRemoveActor={handleRemove}
        onRestartAgentRuntime={handleRestart}
      />
      <SheetModal
        onRequestClose={() => setAddMode(null)}
        visible={addMode !== null}
      >
        <MemberPickerSheet
          actors={pickerCandidates}
          excludeActorIds={participantIds}
          onCancel={() => setAddMode(null)}
          onConfirm={handleAdd}
        />
      </SheetModal>
      <SheetModal
        onRequestClose={() => setModelPickerActorId(null)}
        visible={modelPickerAgent !== null}
      >
        {modelPickerAgent ? (
          <ModelPickerSheet
            agentName={modelPickerAgent.displayName}
            currentModel={modelPickerAgent.currentModel}
            models={modelPickerAgent.availableModels}
            onCancel={() => setModelPickerActorId(null)}
            onSelect={(modelId) => {
              void handlePickModel(modelId);
            }}
          />
        ) : null}
      </SheetModal>
    </>
  );
}
