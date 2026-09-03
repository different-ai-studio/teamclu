import type {
  IdeaActivityRow,
  IdeaDetailRow,
  IdeaFullUpdateInput,
  IdeaRow,
  IdeaSortOrderUpdateInput,
  IdeasBackend,
} from "@/lib/backend/types";
import type { CloudApiClient } from "@/lib/backend/cloud-api/http";

type CloudIdea = {
  id: string;
  teamId: string;
  title: string;
  body?: string | null;
  description?: string | null;
  workspaceId?: string | null;
  status?: string | null;
  createdByActorId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  archivedAt?: string | null;
  archived?: boolean | null;
  sortOrder?: number | null;
};

type CloudIdeaActivity = {
  id: string;
  actorId: string;
  /** The wire name; `activityType` is served as an alias by some repos. */
  kind?: string | null;
  activityType?: string | null;
  content?: string | null;
  createdAt: string;
};

/** The subset of the actors payload the idea detail needs for display names. */
type CloudIdeaActor = {
  id: string;
  kind?: string | null;
  displayName?: string | null;
};

function mapIdea(row: CloudIdea): IdeaRow {
  return {
    id: row.id,
    team_id: row.teamId,
    title: row.title,
    body: row.body ?? null,
    description: row.description ?? null,
    workspace_id: row.workspaceId ?? null,
    status: row.status ?? null,
    created_by_actor_id: row.createdByActorId ?? null,
    created_at: row.createdAt ?? null,
    updated_at: row.updatedAt ?? null,
    archived_at: row.archivedAt ?? null,
    archived: row.archived ?? null,
    sort_order: row.sortOrder ?? null,
  };
}

function mapActivity(row: CloudIdeaActivity): IdeaActivityRow {
  return {
    id: row.id,
    actor_id: row.actorId,
    activity_type: row.activityType ?? row.kind ?? "progress",
    content: row.content ?? null,
    created_at: row.createdAt,
  };
}

function isSortOrderUpdate(input: IdeaSortOrderUpdateInput | IdeaFullUpdateInput): input is IdeaSortOrderUpdateInput {
  return Object.prototype.hasOwnProperty.call(input, "sortOrder");
}

export function createIdeasModule(client: CloudApiClient): IdeasBackend {
  return {
    async listIdeas(teamId) {
      const out = await client.get<{ items: CloudIdea[] }>(`/v1/ideas?teamId=${encodeURIComponent(teamId)}`);
      return out.items.map(mapIdea);
    },
    async getIdeaDetail(ideaId) {
      try {
        // The detail endpoint carries only the idea row; activities live on
        // their own endpoint, and actor display names on the actors API.
        const [row, activitiesOut] = await Promise.all([
          client.get<CloudIdea>(`/v1/ideas/${encodeURIComponent(ideaId)}`),
          client.get<{ items: CloudIdeaActivity[] }>(
            `/v1/ideas/${encodeURIComponent(ideaId)}/activities`,
          ),
        ]);
        const activities = activitiesOut.items ?? [];
        const actorIds = Array.from(
          new Set(
            [row.createdByActorId, ...activities.map((a) => a.actorId)].filter(
              (id): id is string => !!id,
            ),
          ),
        );
        const actors =
          actorIds.length > 0
            ? (await client.post<{ items: CloudIdeaActor[] }>("/v1/actors/by-ids", { actorIds }))
                .items ?? []
            : [];
        return {
          ...mapIdea(row),
          activities: activities.map(mapActivity),
          actors: actors.map((a) => ({
            id: a.id,
            display_name: a.displayName ?? null,
            actor_type: a.kind ?? null,
          })),
        } as IdeaDetailRow;
      } catch {
        return null;
      }
    },
    async createIdea(input) {
      return mapIdea(await client.post<CloudIdea>("/v1/ideas", {
        teamId: input.teamId,
        title: input.title,
        body: input.body ?? null,
        workspaceId: input.workspaceId ?? null,
      }));
    },
    async updateIdea(input) {
      if (isSortOrderUpdate(input)) {
        await client.patch<CloudIdea>(`/v1/ideas/${encodeURIComponent(input.ideaId)}`, { sortOrder: input.sortOrder });
      } else {
        await client.patch<CloudIdea>(`/v1/ideas/${encodeURIComponent(input.ideaId)}`, {
          title: input.title,
          body: input.body ?? null,
          description: input.description ?? null,
          status: input.status,
          workspaceId: input.workspaceId,
        });
      }
    },
    async archiveIdea(ideaId) {
      await client.post<void>(`/v1/ideas/${encodeURIComponent(ideaId)}/archive`, {});
    },
    async createIdeaActivity(input) {
      await client.post<void>(`/v1/ideas/${encodeURIComponent(input.ideaId)}/activities`, {
        actorId: input.actorId ?? null,
        activityType: input.activityType ?? input.eventType,
        content: input.content ?? null,
        metadata: input.metadata ?? {},
      });
    },
  };
}
