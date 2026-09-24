export type IdeaStatus = "open" | "in_progress" | "done";

export type Idea = {
  ideaId: string;
  teamId: string;
  workspaceId: string | null;
  workspaceName: string | null;
  createdByActorId: string | null;
  title: string;
  description: string;
  status: IdeaStatus;
  archived: boolean;
  /** Manual ordering key (`ideas.sort_order`); 0 when the backend omits it. */
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  /**
   * Pictures posted with the idea itself — distinct from a comment's
   * attachments, which belong to the activity that carried them.
   */
  attachmentUrls: string[];
  /**
   * Feed counts. Only the list endpoint aggregates them (a single-idea read
   * reports none), and they are never written to the SQLite cache: a count
   * about other people goes stale the moment it is stored, and a stale count
   * shown offline is worse than none (iOS `IdeaStore.applyLikeState`). A
   * cache-painted idea reads zeros until the refresh lands.
   */
  commentCount: number;
  likeCount: number;
  likedByMe: boolean;
};

/**
 * Ordering used by the ideas list, ported from iOS `IdeaStore.sort`: manual
 * `sortOrder` first, then most-recently-updated, then newest-created.
 */
export function compareIdeas(lhs: Idea, rhs: Idea): number {
  if (lhs.sortOrder !== rhs.sortOrder) return lhs.sortOrder - rhs.sortOrder;
  if (lhs.updatedAt !== rhs.updatedAt) return rhs.updatedAt.localeCompare(lhs.updatedAt);
  return rhs.createdAt.localeCompare(lhs.createdAt);
}

/**
 * Move `ideaId` to `destinationIndex` within `ideas` and return the new id
 * order. Mirrors iOS `IdeaStore.moveIdeas`, which renumbers `sortOrder` to
 * `(index + 1) * 1000` and posts the resulting id list to the Cloud API.
 */
export function reorderIdeaIds(
  ideas: ReadonlyArray<Idea>,
  ideaId: string,
  destinationIndex: number,
): string[] {
  const ids = ideas.map((idea) => idea.ideaId);
  const from = ids.indexOf(ideaId);
  if (from < 0) return ids;
  const to = Math.max(0, Math.min(ids.length - 1, destinationIndex));
  if (from === to) return ids;
  ids.splice(from, 1);
  ids.splice(to, 0, ideaId);
  return ids;
}

/** `sortOrder` iOS assigns to position `index` after a reorder. */
export function sortOrderForIndex(index: number): number {
  return (index + 1) * 1000;
}

/**
 * One row of an idea's activity feed (`idea_activities`). Mirrors iOS
 * `IdeaActivityRecord`: `activityType` is the wire `kind`, and `attachmentUrls`
 * only comes back from backends that persist them (the Supabase repo does; the
 * pg repo drops them today).
 */
export type IdeaActivity = {
  id: string;
  ideaId: string;
  teamId: string;
  actorId: string;
  activityType: string;
  content: string;
  metadata: Record<string, string>;
  attachmentUrls: string[];
  createdAt: string;
  updatedAt: string;
};

export function isProgressActivity(activity: IdeaActivity): boolean {
  return activity.activityType === "progress";
}

export function isStatusChangeActivity(activity: IdeaActivity): boolean {
  return activity.activityType === "status_change";
}

export function isReorderActivity(activity: IdeaActivity): boolean {
  return activity.activityType === "reorder";
}

export type IdeasListState = {
  status: "idle" | "loading" | "error" | "ready";
  ideas: Idea[];
  isLoading: boolean;
  isRefreshing: boolean;
  errorMessage: string | null;
};

export const initialIdeasListState: IdeasListState = {
  status: "idle",
  ideas: [],
  isLoading: false,
  isRefreshing: false,
  errorMessage: null,
};

export function isOpenIdea(idea: Idea): boolean {
  return idea.status === "open";
}

export function isDoneIdea(idea: Idea): boolean {
  return idea.status === "done";
}

export function isMineIdea(idea: Idea, actorId: string | null): boolean {
  if (!actorId) return false;
  return idea.createdByActorId === actorId;
}
