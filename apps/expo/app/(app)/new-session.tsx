import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useConnectedAgentsStore, useOnboarding, useTeamMqtt } from "../_layout";
import { createActorsApi } from "../../src/features/actors/actor-api";
import { isAgentActor, type Actor } from "../../src/features/actors/actor-types";
import { createIdeasApi } from "../../src/features/ideas/idea-api";
import { isOpenIdea, type Idea } from "../../src/features/ideas/idea-types";
import { createWorkspacesApi } from "../../src/features/workspaces/workspace-api";
import { buildFirstMessageWithIdea } from "../../src/features/sessions/idea-preface";
import { resolveInitialMessageMentionActorIds } from "../../src/features/sessions/session-mention-resolver";
import { resolveAgentRuntimeStartPlans } from "../../src/features/sessions/runtime-start";
import { createConfiguredSessionsApi } from "../../src/features/sessions/api-provider";
import {
  deriveSessionTitle,
  startSessionWithAgents,
} from "../../src/features/sessions/start-session";
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
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [workspaces, setWorkspaces] = useState<AgentWorkspaceChoice[]>([]);

  useEffect(() => {
    const teamId = state.currentTeam?.id;
    if (!teamId) return;
    let cancelled = false;
    void Promise.all([
      createActorsApi({ getAccessToken: supabaseAccessToken(supabase) }).listActors(teamId),
      createIdeasApi({ getAccessToken: supabaseAccessToken(supabase) }).listIdeas(teamId),
      createWorkspacesApi({ getAccessToken: supabaseAccessToken(supabase) }).list(teamId),
    ])
      .then(([actorRows, ideaRows, workspaceRows]) => {
        if (cancelled) return;
        setActors(actorRows);
        setIdeas(ideaRows.filter(isOpenIdea));
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
        setIdeas([]);
        setWorkspaces([]);
      });
    return () => {
      cancelled = true;
    };
  }, [state.currentTeam?.id]);

  useEffect(() => {
    void connectedAgentsStore?.reload();
  }, [connectedAgentsStore]);

  const ideaChoices = useMemo(
    () =>
      ideas.map((idea) => ({
        ideaId: idea.ideaId,
        displayTitle: idea.title.trim() || tHook("Untitled idea"),
      })),
    [ideas],
  );

  return (
    <NewSessionScreen
      actors={actors}
      currentMemberActorId={state.currentMemberActorId}
      errorMessage={errorMessage}
      ideas={ideaChoices}
      isBusy={isBusy}
      selectedIdeaId={ideaId}
      workspaces={workspaces}
      onClose={() => router.back()}
      onCreate={async ({
        firstMessage,
        collaboratorActorIds,
        primaryAgentActorId,
        agentConfig,
        ideaId: chosenIdeaId,
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
          const runtimePlans =
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

          if (runtimePlans.length > 0 && !teamMqtt) {
            throw new Error(tHook("MQTT is not connected — wait for TeamClu to reconnect."));
          }

          const idea = chosenIdeaId
            ? ideas.find((row) => row.ideaId === chosenIdeaId)
            : undefined;
          const expandedMessage = buildFirstMessageWithIdea(firstMessage, idea);
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
              collaboratorActorIds,
              mentionActorIds: resolveInitialMessageMentionActorIds({
                collaboratorActorIds,
                teamActors: actors,
              }),
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
