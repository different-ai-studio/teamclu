import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useOnboarding } from "../_layout";
import { createActorsApi } from "../../src/features/actors/actor-api";
import type { Actor } from "../../src/features/actors/actor-types";
import {
  createLeaderboardApi,
  type LeaderboardEntry,
} from "../../src/features/actors/leaderboard-api";
import { TeamStatsSheet } from "../../src/features/actors/screens/TeamStatsSheet";
import {
  leaderboardPeriodFor,
  type TeamStatsPeriod,
} from "../../src/features/actors/team-stats";
import { supabaseAccessToken } from "../../src/lib/cloud-api/client";
import { supabase } from "../../src/lib/supabase/client";

export default function TeamStatsRoute() {
  const router = useRouter();
  const { t } = useTranslation();
  const { state } = useOnboarding();
  const teamId = state.currentTeam?.id ?? "";

  const [actors, setActors] = useState<Actor[]>([]);
  const [period, setPeriod] = useState<TeamStatsPeriod>("week");
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const leaderboardApi = useMemo(
    () => createLeaderboardApi({ getAccessToken: supabaseAccessToken(supabase) }),
    [],
  );

  // The directory resolves names and agent/member shape for the ranking.
  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    void createActorsApi({ getAccessToken: supabaseAccessToken(supabase) })
      .listActors(teamId)
      .then((rows) => {
        if (!cancelled) setActors(rows);
      })
      .catch(() => {
        if (!cancelled) setActors([]);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  useEffect(() => {
    if (!teamId) {
      setErrorMessage(t("Team stats need a signed-in Cloud API session."));
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setErrorMessage(null);
    void leaderboardApi
      .getLeaderboard(teamId, leaderboardPeriodFor(period))
      .then((rows) => {
        if (!cancelled) setEntries(rows);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setEntries([]);
        setErrorMessage(err instanceof Error ? err.message : t("Stats Unavailable"));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [leaderboardApi, period, teamId, t]);

  return (
    <TeamStatsSheet
      actors={actors}
      entries={entries}
      errorMessage={errorMessage}
      isLoading={isLoading}
      onChangePeriod={setPeriod}
      onClose={() => router.back()}
      period={period}
    />
  );
}
