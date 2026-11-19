import { useRouter } from "expo-router";
import { useEffect, useState } from "react";

import { useOnboarding } from "../_layout";
import { createActorsApi } from "../../src/features/actors/actor-api";
import type { Actor } from "../../src/features/actors/actor-types";
import { createIdeasApi } from "../../src/features/ideas/idea-api";
import type { Idea } from "../../src/features/ideas/idea-types";
import { IdeaStatsSheet } from "../../src/features/ideas/screens/IdeaStatsSheet";
import { cloudAccessToken } from "../../src/lib/cloud-api/client";
import { cloudAuth } from "../../src/lib/auth/cloud-auth";

export default function IdeaStatsRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const teamId = state.currentTeam?.id ?? "";

  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [actors, setActors] = useState<Actor[]>([]);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    void (async () => {
      try {
        const [rows, actorRows] = await Promise.all([
          // Archived ideas still count toward the period totals (iOS sums
          // `ideas + archivedIdeas`), so pull both buckets.
          createIdeasApi({ getAccessToken: cloudAccessToken(cloudAuth) }).listIdeas(teamId, {
            includeArchived: true,
          }),
          createActorsApi({ getAccessToken: cloudAccessToken(cloudAuth) }).listActors(teamId),
        ]);
        if (cancelled) return;
        setIdeas(rows);
        setActors(actorRows);
      } catch {
        if (cancelled) return;
        setIdeas([]);
        setActors([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  return <IdeaStatsSheet actors={actors} ideas={ideas} onClose={() => router.back()} />;
}
