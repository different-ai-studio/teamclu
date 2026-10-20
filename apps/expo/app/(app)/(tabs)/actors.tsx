import { Redirect, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import { routeToHref, useConnectedAgentsStore, useOnboarding } from "../../_layout";
import { createActorsApi } from "../../../src/features/actors/actor-api";
import { createActorsController } from "../../../src/features/actors/actor-controller";
import type { ConnectedAgentsStoreState } from "../../../src/features/actors/connected-agents-store";
import { ActorsListScreen } from "../../../src/features/actors/screens/ActorsListScreen";
import { supabase } from "../../../src/lib/supabase/client";
import { supabaseAccessToken } from "../../../src/lib/cloud-api/client";
import { createActorsCache } from "../../../src/lib/db/team-cache";

/** Stable no-op store so `useSyncExternalStore` can run before MQTT connects. */
const noopSubscribe = () => () => {};
const EMPTY_AGENTS_STATE: ConnectedAgentsStoreState = {
  agents: [],
  presenceByAgentId: new Map(),
  isLoading: false,
  errorMessage: null,
};
const emptyAgentsState = () => EMPTY_AGENTS_STATE;

// Module-scoped: one cache handle for the app, not one per render.
const actorsCache = createActorsCache();

export default function ActorsIndexRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const href = routeToHref(state.route);
  const teamId = state.currentTeam?.id ?? "";
  const controllerRef = useRef<ReturnType<typeof createActorsController> | null>(null);
  const teamIdRef = useRef<string | null>(null);

  if (controllerRef.current === null || teamIdRef.current !== teamId) {
    controllerRef.current = createActorsController(
      createActorsApi({ getAccessToken: supabaseAccessToken(supabase) }),
      teamId,
      actorsCache,
    );
    teamIdRef.current = teamId;
  }

  const controller = controllerRef.current;
  const listState = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );

  useEffect(() => {
    if (!teamId) return;
    void controller.load();
  }, [controller, teamId]);

  useFocusEffect(
    useCallback(() => {
      if (!teamId) return;
      void controller.refresh();
    }, [controller, teamId]),
  );

  // "You have no accessible agent" — sourced from agent_member_access, which
  // covers private agents too, so a user with only a personal agent isn't
  // nagged. Distinct from the team-has-none reminder on the Sessions tab.
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

  return (
    <ActorsListScreen
      currentActorId={state.currentMemberActorId}
      onInvite={() => router.push("/(app)/invite")}
      onLoad={() => {
        void controller.load();
      }}
      onOpenStats={() => router.push("/(app)/team-stats")}
      onRefresh={() => {
        void controller.refresh();
      }}
      onSelectActor={(actorId) => {
        router.push(`/(app)/actor-detail?actorId=${actorId}`);
      }}
      showAddYourAgentNotice={
        agentsStore !== null && !agentsState.isLoading && agentsState.agents.length === 0
      }
      state={listState}
    />
  );
}
