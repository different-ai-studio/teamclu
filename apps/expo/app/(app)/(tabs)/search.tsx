import { Redirect, useRouter } from "expo-router";
import { useEffect, useState } from "react";

import { routeToHref, useOnboarding } from "../../_layout";
import { createActorsApi } from "../../../src/features/actors/actor-api";
import type { Actor } from "../../../src/features/actors/actor-types";
import { createIdeasApi } from "../../../src/features/ideas/idea-api";
import type { Idea } from "../../../src/features/ideas/idea-types";
import { SearchScreen } from "../../../src/features/search/screens/SearchScreen";
import { createConfiguredSessionsApi } from "../../../src/features/sessions/api-provider";
import type { SessionSummary } from "../../../src/features/sessions/session-types";
import { supabase } from "../../../src/lib/supabase/client";
import { supabaseAccessToken } from "../../../src/lib/cloud-api/client";

export default function SearchIndexRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const href = routeToHref(state.route);
  const teamId = state.currentTeam?.id ?? "";

  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [actors, setActors] = useState<Actor[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    setIsLoading(true);
    (async () => {
      const sessionsApi = createConfiguredSessionsApi(supabase);
      const ideasApi = createIdeasApi({ getAccessToken: supabaseAccessToken(supabase) });
      const actorsApi = createActorsApi({ getAccessToken: supabaseAccessToken(supabase) });
      try {
        const [nextSessions, nextIdeas, nextActors] = await Promise.all([
          sessionsApi.listSessions(teamId),
          ideasApi.listIdeas(teamId),
          actorsApi.listActors(teamId),
        ]);
        if (cancelled) return;
        setSessions(nextSessions);
        setIdeas(nextIdeas);
        setActors(nextActors);
      } catch {
        if (cancelled) return;
        setSessions([]);
        setIdeas([]);
        setActors([]);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
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

  return (
    <SearchScreen
      onBack={() => (router.canGoBack() ? router.back() : router.replace("/(app)/sessions"))}
      actors={actors}
      ideas={ideas}
      isLoading={isLoading}
      onSelectActor={(actorId) => router.push(`/(app)/actor-detail?actorId=${actorId}`)}
      onSelectIdea={(ideaId) => router.push(`/(app)/idea-detail?ideaId=${ideaId}`)}
      onSelectSession={(sessionId) => router.push(`/(app)/sessions/${sessionId}`)}
      sessions={sessions}
    />
  );
}
