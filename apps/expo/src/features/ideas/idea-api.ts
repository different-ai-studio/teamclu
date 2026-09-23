import { cloudApiBaseUrl, createCloudApiClient } from "../../lib/cloud-api/client";
import type { IdeaLikeState } from "./idea-likes";
import { compareIdeas, type Idea, type IdeaActivity, type IdeaStatus } from "./idea-types";

/**
 * Cloud-only ideas provider. Mirrors the iOS CloudAPIIdeaRepository: the FC
 * list endpoint paginates and returns one archived bucket per call, so
 * listIdeas follows the cursor to exhaustion (both buckets when archived is
 * requested). FC ideas carry no workspace name, so — like the prior Supabase
 * join — names are enriched from GET /v1/workspaces.
 */

// FC mapIdeaRow camelCase shape (subset we consume).
type CloudIdea = {
  id: string;
  teamId?: string | null;
  workspaceId?: string | null;
  createdByActorId?: string | null;
  title?: string | null;
  description?: string | null;
  status?: string | null;
  archived?: boolean | null;
  sortOrder?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  attachmentUrls?: string[] | null;
  // Only the list aggregates these; a single-idea read omits them.
  commentCount?: number | null;
  likeCount?: number | null;
  likedByMe?: boolean | null;
};

function toCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function toStatus(value: string | null | undefined): IdeaStatus {
  switch (value) {
    case "in_progress":
      return "in_progress";
    case "done":
      return "done";
    default:
      return "open";
  }
}

function toIdea(row: CloudIdea, workspaceName: string | null): Idea {
  return {
    ideaId: row.id,
    teamId: row.teamId ?? "",
    workspaceId: row.workspaceId ?? null,
    workspaceName,
    createdByActorId: row.createdByActorId ?? null,
    title: row.title?.trim() || "Untitled idea",
    description: row.description ?? "",
    status: toStatus(row.status),
    archived: Boolean(row.archived),
    sortOrder: typeof row.sortOrder === "number" ? row.sortOrder : 0,
    createdAt: row.createdAt ?? "",
    updatedAt: row.updatedAt ?? row.createdAt ?? "",
    attachmentUrls: (row.attachmentUrls ?? []).filter(
      (url): url is string => typeof url === "string" && url.length > 0,
    ),
    commentCount: toCount(row.commentCount),
    likeCount: toCount(row.likeCount),
    likedByMe: row.likedByMe === true,
  };
}

// FC mapIdeaActivityRow / mapActivity camelCase shape. `kind` is the pg-repo
// spelling, `activityType` the Supabase one — both backends are in play.
type CloudIdeaActivity = {
  id: string;
  teamId?: string | null;
  ideaId: string;
  actorId: string;
  kind?: string | null;
  activityType?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
  attachmentUrls?: string[] | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

function toStringMap(value: Record<string, unknown> | null | undefined): Record<string, string> {
  if (!value) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === null || raw === undefined) continue;
    out[key] = typeof raw === "string" ? raw : JSON.stringify(raw);
  }
  return out;
}

function toActivity(row: CloudIdeaActivity): IdeaActivity {
  const createdAt = row.createdAt ?? "";
  return {
    id: row.id,
    ideaId: row.ideaId,
    teamId: row.teamId ?? "",
    actorId: row.actorId,
    activityType: row.activityType ?? row.kind ?? "",
    content: row.content ?? "",
    metadata: toStringMap(row.metadata),
    attachmentUrls: (row.attachmentUrls ?? []).filter((url) => Boolean(url)),
    createdAt,
    updatedAt: row.updatedAt ?? createdAt,
  };
}

export type IdeaActivityCreateInput = {
  activityType: string;
  content: string;
  actorId: string;
  metadata?: Record<string, string>;
  attachmentUrls?: string[];
};

export type IdeasApi = {
  createIdea: (input: {
    teamId: string;
    title: string;
    description?: string;
    workspaceId?: string | null;
    /** Already-uploaded pictures to post with the idea itself. */
    attachmentUrls?: string[];
  }) => Promise<Idea>;
  updateStatus: (ideaId: string, status: IdeaStatus) => Promise<void>;
  updateContent: (
    ideaId: string,
    patch: { title?: string; description?: string },
  ) => Promise<void>;
  archive: (ideaId: string) => Promise<void>;
  unarchive: (ideaId: string) => Promise<void>;
  listIdeas: (teamId: string, options?: { includeArchived?: boolean }) => Promise<Idea[]>;
  listActivities: (ideaId: string) => Promise<IdeaActivity[]>;
  createActivity: (ideaId: string, input: IdeaActivityCreateInput) => Promise<IdeaActivity>;
  reorderIdeas: (teamId: string, ideaIds: string[]) => Promise<void>;
  /**
   * `PUT /v1/ideas/{id}/like` with the desired state — not a toggle, so a
   * retried or doubled request settles on the same answer.
   */
  setLike: (ideaId: string, liked: boolean) => Promise<IdeaLikeState>;
};

export function createIdeasApi(args: {
  getAccessToken: () => Promise<string | null>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): IdeasApi {
  const client = createCloudApiClient({
    baseUrl: args.baseUrl ?? cloudApiBaseUrl(),
    getAccessToken: args.getAccessToken,
    fetchImpl: args.fetchImpl,
  });

  async function fetchBucket(teamId: string, archived: boolean): Promise<CloudIdea[]> {
    const rows: CloudIdea[] = [];
    let cursor: string | null = null;
    do {
      let path = `/v1/ideas?teamId=${encodeURIComponent(teamId)}&limit=200&archived=${archived}`;
      if (cursor) path += `&cursor=${encodeURIComponent(cursor)}`;
      const page = await client.get<{ items: CloudIdea[]; nextCursor: string | null }>(path);
      rows.push(...(page.items ?? []));
      cursor = page.nextCursor ?? null;
    } while (cursor);
    return rows;
  }

  return {
    async createIdea(input) {
      const body: Record<string, unknown> = {
        teamId: input.teamId,
        title: input.title,
        description: input.description ?? "",
      };
      if (input.workspaceId != null) body.workspaceId = input.workspaceId;
      if (input.attachmentUrls && input.attachmentUrls.length > 0) {
        body.attachmentUrls = input.attachmentUrls;
      }
      const row = await client.post<CloudIdea>("/v1/ideas", body);
      return toIdea(row, null);
    },

    async updateStatus(ideaId, status) {
      await client.patch(`/v1/ideas/${encodeURIComponent(ideaId)}`, { status });
    },

    async updateContent(ideaId, patch) {
      const body: Record<string, unknown> = {};
      if (patch.title !== undefined) body.title = patch.title;
      if (patch.description !== undefined) body.description = patch.description;
      await client.patch(`/v1/ideas/${encodeURIComponent(ideaId)}`, body);
    },

    async archive(ideaId) {
      await client.post(`/v1/ideas/${encodeURIComponent(ideaId)}/archive`, { archived: true });
    },

    async unarchive(ideaId) {
      await client.post(`/v1/ideas/${encodeURIComponent(ideaId)}/archive`, { archived: false });
    },

    async listIdeas(teamId, options = {}) {
      if (!teamId) return [];
      const buckets = options.includeArchived ? [false, true] : [false];
      const rows: CloudIdea[] = [];
      for (const archived of buckets) {
        rows.push(...(await fetchBucket(teamId, archived)));
      }

      const workspaceIds = Array.from(
        new Set(rows.map((r) => r.workspaceId).filter((id): id is string => Boolean(id))),
      );
      let workspaceNames = new Map<string, string>();
      if (workspaceIds.length > 0) {
        const ws = await client.get<{ items: { id: string; name: string }[] }>(
          `/v1/workspaces?teamId=${encodeURIComponent(teamId)}&limit=200`,
        );
        workspaceNames = new Map((ws.items ?? []).map((w) => [w.id, w.name?.trim() ?? ""]));
      }

      return rows
        .map((row) =>
          toIdea(row, row.workspaceId ? workspaceNames.get(row.workspaceId) ?? null : null),
        )
        .sort(compareIdeas);
    },

    async listActivities(ideaId) {
      if (!ideaId) return [];
      const page = await client.get<{ items: CloudIdeaActivity[] }>(
        `/v1/ideas/${encodeURIComponent(ideaId)}/activities`,
      );
      // FC orders newest-first; the timeline renders in that order (iOS parity).
      return (page.items ?? []).map(toActivity);
    },

    async createActivity(ideaId, input) {
      const row = await client.post<CloudIdeaActivity>(
        `/v1/ideas/${encodeURIComponent(ideaId)}/activities`,
        {
          kind: input.activityType,
          content: input.content.trim(),
          actorId: input.actorId,
          metadata: input.metadata ?? {},
          attachmentUrls: input.attachmentUrls ?? [],
        },
      );
      return toActivity(row);
    },

    async reorderIdeas(teamId, ideaIds) {
      if (!teamId || ideaIds.length === 0) return;
      await client.post("/v1/ideas/reorder", { teamId, ideaIds });
    },

    async setLike(ideaId, liked) {
      const row = await client.put<{ likeCount?: number | null; likedByMe?: boolean | null }>(
        `/v1/ideas/${encodeURIComponent(ideaId)}/like`,
        { liked },
      );
      return { likeCount: toCount(row?.likeCount), likedByMe: row?.likedByMe === true };
    },
  };
}
