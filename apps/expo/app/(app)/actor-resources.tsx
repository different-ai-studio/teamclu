import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useOnboarding } from "../_layout";
import { ActorResourceListScreen } from "../../src/features/actors/screens/ActorResourceListScreen";
import {
  createTeamResourcesApi,
  type TeamEnvSecret,
  type TeamMcpServer,
  type TeamResourceKind,
  type TeamSkill,
} from "../../src/features/actors/team-resources-api";
import { cloudAccessToken } from "../../src/lib/cloud-api/client";
import { cloudAuth } from "../../src/lib/auth/cloud-auth";

function parseKind(value: unknown): TeamResourceKind {
  return value === "mcp" || value === "env" ? value : "skills";
}

export default function ActorResourcesRoute() {
  const { t } = useTranslation();
  const router = useRouter();
  const { state } = useOnboarding();
  const params = useLocalSearchParams<{
    actorId?: string;
    actorName?: string;
    kind?: string;
  }>();
  const actorId = typeof params.actorId === "string" ? params.actorId : null;
  const actorName = typeof params.actorName === "string" ? params.actorName : t("This actor");
  const kind = parseKind(params.kind);
  const teamId = state.currentTeam?.id ?? "";

  const [skills, setSkills] = useState<TeamSkill[]>([]);
  const [servers, setServers] = useState<TeamMcpServer[]>([]);
  const [envKeys, setEnvKeys] = useState<TeamEnvSecret[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!teamId) {
      setErrorMessage(t("Not signed in to a team."));
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setErrorMessage(null);
    void (async () => {
      const api = createTeamResourcesApi({ getAccessToken: cloudAccessToken(cloudAuth) });
      try {
        if (kind === "skills") {
          const rows = await api.listSkills(teamId, actorId);
          if (!cancelled) setSkills(rows.filter((row) => row.installed));
        } else if (kind === "mcp") {
          const rows = await api.listMcpServers(teamId, actorId);
          if (!cancelled) setServers(rows.filter((row) => row.installed));
        } else {
          const rows = await api.listEnvSecrets(teamId);
          if (!cancelled) setEnvKeys(rows);
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMessage(err instanceof Error ? err.message : t("Couldn't load resources."));
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actorId, kind, teamId]);

  return (
    <ActorResourceListScreen
      actorName={actorName}
      envKeys={envKeys}
      errorMessage={errorMessage}
      isLoading={isLoading}
      kind={kind}
      onClose={() => router.back()}
      servers={servers}
      skills={skills}
    />
  );
}
