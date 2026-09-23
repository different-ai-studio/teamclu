import { Redirect, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { routeToHref, useOnboarding } from "../../_layout";
import { createActorsApi } from "../../../src/features/actors/actor-api";
import { createIdeasApi } from "../../../src/features/ideas/idea-api";
import { createIdeasController } from "../../../src/features/ideas/idea-controller";
import { reorderIdeaIds } from "../../../src/features/ideas/idea-types";
import { IdeasListScreen } from "../../../src/features/ideas/screens/IdeasListScreen";
import { supabase } from "../../../src/lib/supabase/client";
import { supabaseAccessToken } from "../../../src/lib/cloud-api/client";
import { createIdeasCache } from "../../../src/lib/db/team-cache";
import { showToast } from "../../../src/ui/Toast";

// Module-scoped: one cache handle for the app, not one per render.
const ideasCache = createIdeasCache();

export default function IdeasIndexRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const href = routeToHref(state.route);
  const teamId = state.currentTeam?.id ?? "";
  const controllerRef = useRef<ReturnType<typeof createIdeasController> | null>(null);
  const teamIdRef = useRef<string | null>(null);

  if (controllerRef.current === null || teamIdRef.current !== teamId) {
    controllerRef.current = createIdeasController(
      createIdeasApi({ getAccessToken: supabaseAccessToken(supabase) }),
      teamId,
      ideasCache,
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

  const [actorNames, setActorNames] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    void createActorsApi({ getAccessToken: supabaseAccessToken(supabase) })
      .listActors(teamId)
      .then((rows) => {
        if (cancelled) return;
        const map = new Map<string, string>();
        for (const row of rows) map.set(row.actorId, row.displayName);
        setActorNames(map);
      })
      .catch(() => {
        if (!cancelled) setActorNames(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  if (state.route !== "ready") {
    return <Redirect href={href ?? "/"} />;
  }

  if (state.currentTeam === null) {
    return <Redirect href="/" />;
  }

  /**
   * Optimistic reorder → POST /v1/ideas/reorder → one `reorder` activity for
   * the moved idea, exactly the sequence iOS `IdeaStore.moveIdeas` performs.
   * A failed write reverts by refetching.
   */
  const handleReorder = async (ideaId: string, destinationIndex: number) => {
    const current = controller.getState().ideas;
    const orderedIds = reorderIdeaIds(current, ideaId, destinationIndex);
    const newIndex = orderedIds.indexOf(ideaId);
    if (newIndex < 0) return;
    controller.applyReorder(orderedIds);
    const api = createIdeasApi({ getAccessToken: supabaseAccessToken(supabase) });
    try {
      await api.reorderIdeas(teamId, orderedIds);
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Couldn't reorder ideas.");
      await controller.refresh();
      return;
    }
    const actorId = state.currentMemberActorId;
    if (!actorId) return;
    try {
      await api.createActivity(ideaId, {
        activityType: "reorder",
        content: `Moved to position ${newIndex + 1}`,
        actorId,
        metadata: { position: `${newIndex + 1}`, total: `${orderedIds.length}` },
      });
    } catch {
      // The order itself saved; the audit row is best-effort.
    }
  };

  return (
    <IdeasListScreen
      actorNames={actorNames}
      currentActorId={state.currentMemberActorId}
      onCreate={() => router.push("/(app)/new-idea")}
      onOpenArchived={() => router.push("/(app)/archived-ideas")}
      onOpenStats={() => router.push("/(app)/idea-stats")}
      onArchiveBatch={async (ideaIds) => {
        const api = createIdeasApi({ getAccessToken: supabaseAccessToken(supabase) });
        for (const id of ideaIds) {
          try {
            await api.archive(id);
          } catch {
            // Continue archiving the rest; controller refresh picks up the partial diff.
          }
        }
        await controller.refresh();
      }}
      onLoad={() => {
        void controller.load();
      }}
      onRefresh={() => {
        void controller.refresh();
      }}
      onReorder={(ideaId, destinationIndex) => {
        void handleReorder(ideaId, destinationIndex);
      }}
      onSelectIdea={(ideaId) => {
        router.push(`/(app)/idea-detail?ideaId=${ideaId}`);
      }}
      onToggleLike={(ideaId, liked) => {
        void controller.setLiked(ideaId, liked).then((error) => {
          if (error) showToast("error", error);
        });
      }}
      state={listState}
    />
  );
}
