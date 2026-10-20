import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useOnboarding } from "../_layout";
import { memberIdeas } from "../../src/features/actors/member-activity-stats";
import { ActorIdeasListScreen } from "../../src/features/actors/screens/ActorIdeasListScreen";
import { createIdeasApi } from "../../src/features/ideas/idea-api";
import type { Idea } from "../../src/features/ideas/idea-types";
import { supabaseAccessToken } from "../../src/lib/cloud-api/client";
import { supabase } from "../../src/lib/supabase/client";

export default function ActorIdeasRoute() {
  const { t } = useTranslation();
  const router = useRouter();
  const { state } = useOnboarding();
  const params = useLocalSearchParams<{ actorId?: string; actorName?: string }>();
  const actorId = typeof params.actorId === "string" ? params.actorId : null;
  const actorName = typeof params.actorName === "string" ? params.actorName : t("This actor");
  const teamId = state.currentTeam?.id ?? "";

  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!teamId || !actorId) {
      setErrorMessage(t("Ideas need a signed-in Cloud API session."));
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setErrorMessage(null);
    void createIdeasApi({ getAccessToken: supabaseAccessToken(supabase) })
      .listIdeas(teamId)
      .then((rows) => {
        // Same selection as the count that opened this list.
        if (!cancelled) setIdeas(memberIdeas(rows, actorId));
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setErrorMessage(err instanceof Error ? err.message : t("Couldn't load ideas."));
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [actorId, teamId, t]);

  return (
    <ActorIdeasListScreen
      actorName={actorName}
      errorMessage={errorMessage}
      ideas={ideas}
      isLoading={isLoading}
      onClose={() => router.back()}
      onSelectIdea={(ideaId) =>
        router.push(`/(app)/idea-detail?ideaId=${encodeURIComponent(ideaId)}`)
      }
    />
  );
}
