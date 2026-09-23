import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "react-native";

import { useConnectedAgentsStore, useOnboarding, useTeamMqtt } from "../_layout";
import { createActorsApi } from "../../src/features/actors/actor-api";
import type { Actor } from "../../src/features/actors/actor-types";
import type { ConnectedAgent } from "../../src/features/actors/connected-agent-types";
import { createWorkspacesApi, type Workspace } from "../../src/features/workspaces/workspace-api";
import { createConfiguredSessionsApi } from "../../src/features/sessions/api-provider";
import { useVoiceRecorder } from "../../src/features/sessions/components/voice-recorder";
import { VoiceCaptureScreen } from "../../src/features/sessions/screens/VoiceCaptureScreen";
import {
  initialVoiceCaptureState,
  resolveVoiceTarget,
  startVoiceSession,
  voiceCaptureReducer,
  voiceRuntimeAgent,
  VoiceSessionError,
  type VoiceCaptureError,
} from "../../src/features/sessions/voice-session";
import { createRuntimeRpcClient } from "../../src/lib/teamclu/runtime-rpc";
import { supabase } from "../../src/lib/supabase/client";
import { supabaseAccessToken } from "../../src/lib/cloud-api/client";
import { uuidV4 } from "../../src/lib/uuid";
import { showToast } from "../../src/ui/Toast";

type Directory = { actors: Actor[]; workspaces: Workspace[] };

/**
 * Voice tab — speak once to start a new session (iOS #1557).
 *
 * preparing → recording → (awaitingAgent when there is no usable default) →
 * startingSession → the new session. The phase machine is
 * `voiceCaptureReducer`; this route only wires it to the recorder, the Cloud
 * API and the runtime RPC.
 */
export default function VoiceCaptureRoute() {
  const { t } = useTranslation();
  const router = useRouter();
  const { state: onboarding } = useOnboarding();
  const teamMqtt = useTeamMqtt();
  const agentsStore = useConnectedAgentsStore();
  const recorder = useVoiceRecorder();
  const [state, dispatch] = useReducer(voiceCaptureReducer, initialVoiceCaptureState);

  const teamId = onboarding.currentTeam?.id ?? "";
  const memberActorId = onboarding.currentMemberActorId;

  // Async work checks this before touching the screen: a take the user
  // cancelled (or left via the back gesture) must not navigate anywhere.
  const abandoned = useRef(false);
  useEffect(() => {
    abandoned.current = false;
    return () => {
      abandoned.current = true;
    };
  }, []);

  const actorsApi = useMemo(
    () => createActorsApi({ getAccessToken: supabaseAccessToken(supabase) }),
    [],
  );
  const workspacesApi = useMemo(
    () => createWorkspacesApi({ getAccessToken: supabaseAccessToken(supabase) }),
    [],
  );

  // Fetched while the user is still talking, so Done doesn't wait on it.
  const directory = useRef<Promise<Directory> | null>(null);
  const loadDirectory = useCallback((): Promise<Directory> => {
    if (!directory.current) {
      directory.current = Promise.all([
        actorsApi.listActors(teamId).catch(() => [] as Actor[]),
        workspacesApi.list(teamId),
      ]).then(([actors, workspaces]) => ({ actors, workspaces }));
      // Let a failed fetch be retried by the next caller.
      directory.current.catch(() => {
        directory.current = null;
      });
    }
    return directory.current;
  }, [actorsApi, teamId, workspacesApi]);

  const fail = useCallback((error: unknown) => {
    if (abandoned.current) return;
    const payload: VoiceCaptureError =
      error instanceof VoiceSessionError
        ? error.error
        : {
            kind: "message",
            message: error instanceof Error ? error.message : String(error),
          };
    dispatch({ type: "failed", error: payload });
  }, []);

  // Start listening the moment the screen opens — it is the take, not a
  // landing page.
  useEffect(() => {
    if (teamId) {
      void loadDirectory().catch(() => {});
      void agentsStore?.reload();
    }
    recorder
      .start()
      .then(() => {
        if (!abandoned.current) dispatch({ type: "recordingStarted" });
      })
      .catch(() => fail(new VoiceSessionError({ kind: "permissionDenied" })));
    // Mount-only: the recorder object is recreated every render.
  }, []);

  const createSession = useCallback(
    async (transcript: string, agent: ConnectedAgent) => {
      if (!teamId || !memberActorId || !agentsStore) {
        throw new VoiceSessionError({ kind: "notReady" });
      }
      const { actors, workspaces } = await loadDirectory();
      const sessionId = await startVoiceSession(
        {
          sessionsApi: createConfiguredSessionsApi(supabase),
          runtimeRpc: teamMqtt
            ? createRuntimeRpcClient({ mqtt: teamMqtt, teamId, requesterActorId: memberActorId })
            : null,
          newMessageId: uuidV4,
          onRuntimeStartError: (_plan, err) => {
            showToast(
              "error",
              err instanceof Error
                ? t("Couldn't start {{value}}: {{message}}", {
                    value: agent.displayName,
                    message: err.message,
                  })
                : t("Couldn't start {{value}}.", { value: agent.displayName }),
            );
          },
        },
        {
          teamId,
          memberActorId,
          transcript,
          agent: voiceRuntimeAgent(
            agent,
            actors.find((actor) => actor.actorId === agent.agentId),
          ),
          connectedAgentIds: agentsStore.getState().agents.map((row) => row.agentId),
          workspaces: workspaces
            .filter((row) => !row.archived)
            .map((row) => ({ id: row.id, path: row.path ?? "", agentId: row.agentId })),
          fallbackTitle: t("New Session"),
        },
      );
      if (abandoned.current) return;
      dispatch({ type: "sessionStarted", sessionId });
      router.replace(`/(app)/sessions/${sessionId}`);
    },
    [agentsStore, loadDirectory, memberActorId, router, t, teamId, teamMqtt],
  );

  const onDone = useCallback(async () => {
    const transcript = (await recorder.stop()).trim();
    if (abandoned.current) return;
    dispatch({ type: "stopped", transcript });
    if (!transcript) return;
    try {
      if (!teamId || !agentsStore) throw new VoiceSessionError({ kind: "notReady" });
      await agentsStore.reload();
      const effectiveDefaultAgentId = await actorsApi
        .getEffectiveDefaultAgent(teamId)
        .catch(() => null);
      const target = resolveVoiceTarget({
        agents: agentsStore.getState().agents,
        effectiveDefaultAgentId,
      });
      if (abandoned.current) return;
      switch (target.kind) {
        case "noAgents":
          throw new VoiceSessionError({ kind: "noAgents" });
        case "needsPick":
          // Park the take and hand over to the picker; creation resumes in
          // `onPickAgent`.
          dispatch({ type: "needsPick", agents: target.agents });
          return;
        case "agent":
          await createSession(transcript, target.agent);
          return;
      }
    } catch (error) {
      fail(error);
    }
  }, [actorsApi, agentsStore, createSession, fail, recorder, teamId]);

  const onPickAgent = useCallback(
    async (agent: ConnectedAgent) => {
      dispatch({ type: "agentPicked" });
      try {
        // Remembered as the viewer's personal default so the next take
        // doesn't ask. A failed save is not worth losing the take over.
        if (teamId) {
          await actorsApi.setMemberDefaultAgent(teamId, agent.agentId).catch(() => null);
        }
        await createSession(state.transcript, agent);
      } catch (error) {
        fail(error);
      }
    },
    [actorsApi, createSession, fail, state.transcript, teamId],
  );

  const onCancel = useCallback(() => {
    abandoned.current = true;
    dispatch({ type: "cancel" });
    // Unmounting the recorder aborts the recognizer and drops the take.
    router.back();
  }, [router]);

  // Failures surface as an alert, then the screen closes — as on iOS, where
  // the alert lands back on Sessions.
  useEffect(() => {
    if (state.phase !== "failed" || !state.error) return;
    Alert.alert(t("Voice chat couldn't start"), describeError(state.error, t), [
      { text: t("OK"), onPress: () => router.back() },
    ], { cancelable: false });
  }, [router, state.error, state.phase, t]);

  return (
    <VoiceCaptureScreen
      durationMs={recorder.durationMs}
      level={recorder.level}
      onCancel={onCancel}
      onDone={() => void onDone()}
      onPickAgent={(agent) => void onPickAgent(agent)}
      phase={state.phase}
      pickableAgents={state.pickableAgents}
      transcript={state.transcript || recorder.transcript}
    />
  );
}

function describeError(
  error: VoiceCaptureError,
  t: (key: string) => string,
): string {
  switch (error.kind) {
    case "emptyTranscript":
      return t("No speech was recognized. Try recording again.");
    case "permissionDenied":
      return t("Microphone and speech recognition access are required for voice chat.");
    case "noAgents":
      return t("Add an agent before starting voice chat.");
    case "notReady":
      return t("Voice chat is not ready yet.");
    case "message":
      return error.message;
  }
}
