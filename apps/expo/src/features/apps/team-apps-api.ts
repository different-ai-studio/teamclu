import {
  CloudApiError,
  cloudApiBaseUrl,
  createCloudApiClient,
  supabaseAccessToken,
} from "../../lib/cloud-api/client";
import {
  parseTeamAppFcStatus,
  parseTeamAppProvisionStatus,
  parseTeamAppRelationship,
  parseTeamAppType,
  parseTeamAppVisibility,
  type TeamApp,
  type TeamAppCreateInput,
  type TeamAppSession,
} from "./team-app-types";

/**
 * `/v1/apps` — the read side of the Apps module, plus creating a row. Port of
 * iOS `CloudAPITeamAppRepository`.
 *
 * Deliberately small. Deploying, seeding, env vars, cron and the data browser
 * all need the local daemon or a desktop-sized surface; what a phone is good
 * for is seeing what the team has and opening it.
 */

// FC `App` camelCase shape (subset we consume). See
// docs/openapi/teamclu-api.v1.yaml `components.schemas.App`.
export type CloudTeamApp = {
  id: string;
  teamId?: string | null;
  createdByActorId?: string | null;
  name?: string | null;
  slug?: string | null;
  type?: string | null;
  visibility?: string | null;
  provisionStatus?: string | null;
  fcStatus?: string | null;
  publicUrl?: string | null;
  fcEndpoint?: string | null;
  gitRemoteUrl?: string | null;
  gitAuthKind?: string | null;
  relationship?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type CloudTeamAppSession = {
  id: string;
  teamId?: string | null;
  title?: string | null;
  mode?: string | null;
  lastMessageAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

/** The name was blank after trimming; nothing was sent. */
export class TeamAppNameRequiredError extends Error {
  constructor() {
    super("App name is required.");
    this.name = "TeamAppNameRequiredError";
  }
}

/**
 * 404 from `GET /v1/apps/{id}`. The server answers 404 both for "gone" and for
 * "you may not see it", on purpose, so the message must not claim which.
 */
export class TeamAppNotFoundError extends Error {
  constructor() {
    super("App not found.");
    this.name = "TeamAppNotFoundError";
  }
}

export function toTeamApp(row: CloudTeamApp): TeamApp {
  const createdAt = row.createdAt ?? "";
  return {
    id: row.id,
    teamId: row.teamId ?? "",
    createdByActorId: row.createdByActorId ?? null,
    name: row.name ?? "",
    slug: row.slug ?? "",
    type: parseTeamAppType(row.type),
    visibility: parseTeamAppVisibility(row.visibility),
    provisionStatus: parseTeamAppProvisionStatus(row.provisionStatus),
    fcStatus: parseTeamAppFcStatus(row.fcStatus),
    publicUrl: row.publicUrl ?? null,
    fcEndpoint: row.fcEndpoint ?? null,
    gitRemoteUrl: row.gitRemoteUrl ?? null,
    gitAuthKind: row.gitAuthKind ?? null,
    relationship: parseTeamAppRelationship(row.relationship),
    createdAt,
    updatedAt: row.updatedAt ?? createdAt,
  };
}

export function toTeamAppSession(row: CloudTeamAppSession): TeamAppSession {
  const createdAt = row.createdAt ?? "";
  return {
    id: row.id,
    teamId: row.teamId ?? "",
    title: row.title ?? "",
    mode: row.mode ?? "",
    lastMessageAt: row.lastMessageAt ?? null,
    createdAt,
    updatedAt: row.updatedAt ?? createdAt,
  };
}

/** The `POST /v1/apps` body; throws before any request on a blank name. */
export function buildCreateTeamAppBody(teamId: string, input: TeamAppCreateInput) {
  const name = input.name.trim();
  if (!name) throw new TeamAppNameRequiredError();
  return { teamId, name, type: input.type, visibility: input.visibility };
}

export type TeamAppsApi = {
  listApps: (teamId: string) => Promise<TeamApp[]>;
  getApp: (appId: string) => Promise<TeamApp>;
  /** Inserts the row. The app comes back at `repo_created`, not `ready`. */
  createApp: (teamId: string, input: TeamAppCreateInput) => Promise<TeamApp>;
  listAppSessions: (appId: string) => Promise<TeamAppSession[]>;
};

export function createTeamAppsApi(args: {
  getAccessToken: () => Promise<string | null>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): TeamAppsApi {
  const client = createCloudApiClient({
    baseUrl: args.baseUrl ?? cloudApiBaseUrl(),
    getAccessToken: args.getAccessToken,
    fetchImpl: args.fetchImpl,
  });
  const enc = encodeURIComponent;

  return {
    async listApps(teamId) {
      // No cursor on this endpoint — the server caps at `limit`, newest
      // first. 100 is its own default, restated so a later change to it does
      // not silently change what a phone shows.
      const page = await client.get<{ items?: CloudTeamApp[] | null }>(
        `/v1/apps?teamId=${enc(teamId)}&limit=100`,
      );
      return (page?.items ?? []).map(toTeamApp);
    },

    async getApp(appId) {
      try {
        const row = await client.get<CloudTeamApp>(`/v1/apps/${enc(appId)}`);
        return toTeamApp(row);
      } catch (err) {
        if (err instanceof CloudApiError && err.status === 404) {
          throw new TeamAppNotFoundError();
        }
        throw err;
      }
    },

    async createApp(teamId, input) {
      const body = buildCreateTeamAppBody(teamId, input);
      const row = await client.post<CloudTeamApp>("/v1/apps", body);
      return toTeamApp(row);
    },

    async listAppSessions(appId) {
      const page = await client.get<{ items?: CloudTeamAppSession[] | null }>(
        `/v1/apps/${enc(appId)}/sessions`,
      );
      return (page?.items ?? []).map(toTeamAppSession);
    },
  };
}

// Cloud API is the only client backend. The auth client is used purely as the
// bearer-token source.
export function createConfiguredTeamAppsApi(
  client: Parameters<typeof supabaseAccessToken>[0],
): TeamAppsApi {
  return createTeamAppsApi({ getAccessToken: supabaseAccessToken(client) });
}
