import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useConnectedAgentsStore, useOnboarding, useTeamMqtt } from "../_layout";
import { createActorsApi } from "../../src/features/actors/actor-api";
import { isAgentActor, type Actor } from "../../src/features/actors/actor-types";
import { createConfiguredTeamAppsApi } from "../../src/features/apps/team-apps-api";
import type { TeamApp } from "../../src/features/apps/team-app-types";
import { useAppsFeatureEnabled } from "../../src/features/apps/use-apps-feature";
import { createIdeasApi } from "../../src/features/ideas/idea-api";
import type { Idea } from "../../src/features/ideas/idea-types";
import { createWorkspacesApi } from "../../src/features/workspaces/workspace-api";
import {
  loadLastContactByActor,
  type LastContactByActor,
} from "../../src/features/sessions/actor-picker-ordering";
import { applyAppCheckouts } from "../../src/features/sessions/app-session";
import { buildFirstMessageWithIdea } from "../../src/features/sessions/idea-preface";
import { resolveAgentRuntimeStartPlans } from "../../src/features/sessions/runtime-start";
import { createConfiguredSessionsApi } from "../../src/features/sessions/api-provider";
import {
  autoMentionAgentIds,
  deriveSessionTitle,
  startSessionWithAgents,
} from "../../src/features/sessions/start-session";
import { openCacheDb } from "../../src/lib/db/cache-db";
import {
  NewSessionScreen,
  type AgentWorkspaceChoice,
} from "../../src/features/sessions/screens/NewSessionScreen";
import { createRuntimeRpcClient } from "../../src/lib/teamclu/runtime-rpc";
import { supabase } from "../../src/lib/supabase/client";
import { supabaseAccessToken } from "../../src/lib/cloud-api/client";
import { uuidV4 } from "../../src/lib/uuid";
import { showToast } from "../../src/ui/Toast";
import { t } from "../../src/lib/i18n";

export default function NewSessionRoute() {
  const { t: tHook } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams<{ ideaId?: string }>();
  const ideaId = typeof params.ideaId === "string" ? params.ideaId : null;
  const { state } = useOnboarding();
  const teamMqtt = useTeamMqtt();
  const connectedAgentsStore = useConnectedAgentsStore();
  const [isBusy, setIsBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [actors, setActors] = useState<Actor[]>([]);
  const [idea, setIdea] = useState<Idea | null>(null);
  const [workspaces, setWorkspaces] = useState<AgentWorkspaceChoice[]>([]);
  const appsEnabled = useAppsFeatureEnabled();
  const [apps, setApps] = useState<TeamApp[]>([]);
  const [defaultAgentId, setDefaultAgentId] = useState<string | null>(null);
  const [lastContact, setLastContact] = useState<LastContactByActor>(new Map());
  const workspacesApi = useMemo(
    () => createWorkspacesApi({ getAccessToken: supabaseAccessToken(supabase) }),
    [],
  );

  useEffect(() => {
    const teamId = state.currentTeam?.id;
    if (!teamId) return;
    let cancelled = false;
    void Promise.all([
      createActorsApi({ getAccessToken: supabaseAccessToken(supabase) }).listActors(teamId),
      workspacesApi.list(teamId),
    ])
      .then(([actorRows, workspaceRows]) => {
        if (cancelled) return;
        setActors(actorRows);
        setWorkspaces(
          workspaceRows
            .filter((row) => !row.archived)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((row) => ({
              id: row.id,
              path: row.path ?? "",
              agentId: row.agentId,
            })),
        );
      })
      .catch(() => {
        if (cancelled) return;
        setActors([]);
        setWorkspaces([]);
      });
    // Picker order (iOS #1602): the viewer's default agent first, then by when
    // we last talked. Both are hints — a failure just orders by name.
    void createActorsApi({ getAccessToken: supabaseAccessToken(supabase) })
      .getEffectiveDefaultAgent(teamId)
      .then((id) => {
        if (!cancelled) setDefaultAgentId(id);
      })
      .catch(() => {});
    void openCacheDb()
      .then((db) => loadLastContactByActor(db, teamId))
      .then((map) => {
        if (!cancelled) setLastContact(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [state.currentTeam?.id, workspacesApi]);

  // Opened from an idea: no idea picker any more, but the session is still
  // linked to it and its text prefaces the first message, as on iOS.
  useEffect(() => {
    const teamId = state.currentTeam?.id;
    if (!teamId || !ideaId) {
      setIdea(null);
      return;
    }
    let cancelled = false;
    void createIdeasApi({ getAccessToken: supabaseAccessToken(supabase) })
      .listIdeas(teamId)
      .then((rows) => {
        if (!cancelled) setIdea(rows.find((row) => row.ideaId === ideaId) ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [ideaId, state.currentTeam?.id]);

  useEffect(() => {
    const teamId = state.currentTeam?.id;
    if (!teamId || !appsEnabled) {
      setApps([]);
      return;
    }
    let cancelled = false;
    void createConfiguredTeamAppsApi(supabase)
      .listApps(teamId)
      .then((rows) => {
        if (!cancelled) setApps(rows);
      })
      .catch(() => {
        if (!cancelled) setApps([]);
      });
    return () => {
      cancelled = true;
    };
  }, [appsEnabled, state.currentTeam?.id]);

  const loadAgentWorkspaces = useCallback(
    async (agentId: string): Promise<AgentWorkspaceChoice[]> => {
      const teamId = state.currentTeam?.id;
      if (!teamId) return [];
      const rows = await workspacesApi.list(teamId, { agentId });
      return rows
        .filter((row) => !row.archived)
        .map((row) => ({ id: row.id, path: row.path ?? "", agentId: row.agentId }));
    },
    [state.currentTeam?.id, workspacesApi],
  );

  useEffect(() => {
    void connectedAgentsStore?.reload();
  }, [connectedAgentsStore]);

  return (
    <NewSessionScreen
      actors={actors}
      apps={appsEnabled ? apps : null}
      currentMemberActorId={state.currentMemberActorId}
      defaultAgentId={defaultAgentId}
      errorMessage={errorMessage}
      isBusy={isBusy}
      lastContactByActorId={lastContact}
      loadAgentWorkspaces={loadAgentWorkspaces}
      selectedIdeaId={ideaId}
      workspaces={workspaces}
      onClose={() => router.back()}
      onCreate={async ({
        firstMessage,
        collaboratorActorIds,
        primaryAgentActorId,
        agentConfig,
        ideaId: chosenIdeaId,
        app,
        agentWorkspaces,
      }) => {
        if (!state.currentTeam) {
          setErrorMessage(tHook("No active team — bootstrap first."));
          return;
        }
        const memberActorId = state.currentMemberActorId;
        if (!memberActorId) {
          setErrorMessage(tHook("Couldn't resolve your member identity in this team."));
          return;
        }

        setIsBusy(true);
        setErrorMessage(null);
        try {
          const sessionsApi = createConfiguredSessionsApi(supabase);
          const actorById = new Map(actors.map((actor) => [actor.actorId, actor]));
          const selectedAgents = collaboratorActorIds
            .map((id) => actorById.get(id))
            .filter((actor): actor is Actor => Boolean(actor && isAgentActor(actor)));
          if (selectedAgents.length > 0 && !connectedAgentsStore) {
            throw new Error(tHook("Connected agents are not ready — wait for TeamClu to reconnect."));
          }
          if (selectedAgents.length > 0) {
            await connectedAgentsStore?.reload();
          }
          const resolvedPlans =
            selectedAgents.length > 0
              ? resolveAgentRuntimeStartPlans({
                  agents: selectedAgents.map((actor) => ({
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
                  // Keyed to the agent it was configured for. The sheet
                  // configures the primary agent only, so any others fall back
                  // to their own defaults rather than inheriting its workspace.
                  selectionByAgentId:
                    agentConfig && primaryAgentActorId
                      ? { [primaryAgentActorId]: agentConfig }
                      : null,
                  workspaces: workspaces.map((workspace) => ({
                    id: workspace.id,
                    path: workspace.path,
                    agentId: workspace.agentId ?? null,
                  })),
                })
              : [];
          // An app session runs each agent in its checkout of the app; the
          // screen's app blocker has already made sure every agent has one.
          const runtimePlans = applyAppCheckouts(resolvedPlans, app, [
            ...agentWorkspaces.map((workspace) => ({
              id: workspace.id,
              path: workspace.path,
              agentId: workspace.agentId ?? null,
            })),
            ...workspaces.map((workspace) => ({
              id: workspace.id,
              path: workspace.path,
              agentId: workspace.agentId ?? null,
            })),
          ]);

          if (runtimePlans.length > 0 && !teamMqtt) {
            throw new Error(tHook("MQTT is not connected — wait for TeamClu to reconnect."));
          }

          const linkedIdea = chosenIdeaId && idea?.ideaId === chosenIdeaId ? idea : null;
          const expandedMessage = buildFirstMessageWithIdea(firstMessage, linkedIdea);
          // Exactly one reachable agent is @-mentioned; otherwise nobody is
          // and the user picks with @ in the session (iOS #1601).
          const mentionActorIds = autoMentionAgentIds(
            runtimePlans.map((plan) => plan.agentActorId),
            connectedAgentsStore?.getState().agents.map((agent) => agent.agentId) ?? [],
          );
          const runtimeRpc =
            runtimePlans.length > 0 && teamMqtt
              ? createRuntimeRpcClient({
                  mqtt: teamMqtt,
                  teamId: state.currentTeam.id,
                  requesterActorId: memberActorId,
                })
              : null;
          const sessionId = await startSessionWithAgents(
            {
              sessionsApi,
              runtimeRpc,
              newMessageId: uuidV4,
              onRuntimeStartError: (plan, err) => {
                const actorName =
                  actorById.get(plan.agentActorId)?.displayName ?? tHook("Agent");
                showToast(
                  "error",
                  err instanceof Error
                    ? tHook("Couldn't start {{value}}: {{message}}", { value: actorName, message: err.message })
                    : tHook("Couldn't start {{value}}.", { value: actorName }),
                );
              },
            },
            {
              teamId: state.currentTeam.id,
              memberActorId,
              title: deriveSessionTitle(firstMessage, t("New Session")),
              message: expandedMessage,
              primaryAgentActorId,
              ideaId: chosenIdeaId,
              appId: app?.id ?? null,
              collaboratorActorIds,
              mentionActorIds,
              mentionDisplayNameById: Object.fromEntries(
                selectedAgents.map((actor) => [actor.actorId, actor.displayName]),
              ),
              runtimePlans,
            },
          );

          router.replace(`/(app)/sessions/${sessionId}`);
        } catch (error) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : tHook("Couldn't create the session — try again."),
          );
        } finally {
          setIsBusy(false);
        }
      }}
    />
  );
}
