import {
  loadActors,
  loadIdeas,
  loadShortcuts,
  loadWorkspaces,
  saveActors,
  saveIdeas,
  saveShortcuts,
  saveWorkspaces,
  type CachedActorRow,
  type CachedIdea,
  type CachedShortcut,
  type CachedWorkspace,
} from "./local-cache";
import { openCacheDb, type CacheDb } from "./cache-db";
import type { Idea, IdeaStatus } from "../../features/ideas/idea-types";
import type { Actor, ActorType } from "../../features/actors/actor-types";
import type {
  Shortcut,
  ShortcutNodeType,
  ShortcutScope,
} from "../../features/shortcuts/shortcut-types";

/**
 * Read-through caches for the team-scoped lists.
 *
 * These four screens had no cache at all: ideas, actors, workspaces and
 * shortcuts each came up empty with a spinner until the network answered, and
 * stayed empty offline, where iOS shows last-known state from SwiftData.
 *
 * Every method swallows its errors. A cache is a hint — a failure to read or
 * write one must never surface as an error on a screen that has live data.
 */
export type TeamCache<T> = {
  load: (teamId: string) => Promise<T[] | null>;
  save: (teamId: string, rows: ReadonlyArray<T>) => Promise<void>;
};

function createTeamCache<T>(
  read: (db: CacheDb, teamId: string) => Promise<T[]>,
  write: (db: CacheDb, teamId: string, rows: ReadonlyArray<T>) => Promise<void>,
  getCacheDb: () => Promise<CacheDb>,
): TeamCache<T> {
  return {
    async load(teamId) {
      if (!teamId) return null;
      try {
        const rows = await read(await getCacheDb(), teamId);
        // Null distinguishes "never cached" from "cached, and empty" so a
        // screen can tell a cold start from a genuinely empty team.
        return rows.length > 0 ? rows : null;
      } catch {
        return null;
      }
    },
    async save(teamId, rows) {
      if (!teamId) return;
      try {
        await write(await getCacheDb(), teamId, rows);
      } catch {
        // best-effort
      }
    },
  };
}

/**
 * SQLite has no enums, so `cached_ideas.status` is a plain TEXT column and a
 * row written by an older build (or hand-edited) can hold anything. Narrow it
 * on the way out rather than casting, so a bad value degrades to "open"
 * instead of reaching the UI as an unhandled status.
 */
function toIdeaStatus(value: string): IdeaStatus {
  return value === "in_progress" || value === "done" ? value : "open";
}

/**
 * The cached slice of an idea. Feed counts (`commentCount`, `likeCount`,
 * `likedByMe`) are deliberately left out: they are numbers about other people
 * that go stale the moment they are written, and a stale count shown offline
 * is worse than none (iOS keeps them out of SwiftData for the same reason).
 * `attachmentUrls` has no column in `cached_ideas` either, so a cache-painted
 * idea shows its pictures once the refresh lands.
 */
export function toCachedIdea(idea: Idea): CachedIdea {
  return {
    ideaId: idea.ideaId,
    teamId: idea.teamId,
    workspaceId: idea.workspaceId,
    workspaceName: idea.workspaceName,
    createdByActorId: idea.createdByActorId,
    title: idea.title,
    description: idea.description,
    status: idea.status,
    archived: idea.archived,
    sortOrder: idea.sortOrder,
    createdAt: idea.createdAt,
    updatedAt: idea.updatedAt,
  };
}

/** A cached row back as an `Idea`, with the uncached feed fields zeroed. */
export function fromCachedIdea(row: CachedIdea): Idea {
  return {
    ...row,
    status: toIdeaStatus(row.status),
    attachmentUrls: [],
    commentCount: 0,
    likeCount: 0,
    likedByMe: false,
  };
}

export function createIdeasCache(
  getCacheDb: () => Promise<CacheDb> = openCacheDb,
): TeamCache<Idea> {
  const rows = createTeamCache(loadIdeas, saveIdeas, getCacheDb);
  return {
    async load(teamId) {
      const cached = await rows.load(teamId);
      return cached?.map(fromCachedIdea) ?? null;
    },
    save: (teamId, ideas) => rows.save(teamId, ideas.map(toCachedIdea)),
  };
}

/** Same TEXT-column narrowing as ideas: unknown types read back as members. */
function toActorType(value: string): ActorType {
  return value === "agent" ? "agent" : "member";
}

export function createActorsCache(
  getCacheDb: () => Promise<CacheDb> = openCacheDb,
): TeamCache<Actor> {
  const rows = createTeamCache(loadActors, saveActors, getCacheDb);
  return {
    async load(teamId) {
      const cached = await rows.load(teamId);
      return (
        cached?.map((row) => ({
          ...row,
          actorType: toActorType(row.actorType),
          visibility: row.visibility === "personal" ? ("personal" as const) : null,
        })) ?? null
      );
    },
    save: (teamId, actors) =>
      rows.save(
        teamId,
        actors.map((actor) => ({
          ...actor,
          defaultWorkspaceId: actor.defaultWorkspaceId ?? null,
          ownerMemberId: actor.ownerMemberId ?? null,
          visibility: actor.visibility ?? null,
          memberStatus: actor.memberStatus ?? null,
          agentStatus: actor.agentStatus ?? null,
          email: actor.email ?? null,
          phone: actor.phone ?? null,
          createdAt: actor.createdAt ?? null,
        })) as ReadonlyArray<CachedActorRow>,
      ),
  };
}

export function createWorkspacesCache(
  getCacheDb: () => Promise<CacheDb> = openCacheDb,
): TeamCache<CachedWorkspace> {
  return createTeamCache(loadWorkspaces, saveWorkspaces, getCacheDb);
}

export function createShortcutsCache(
  getCacheDb: () => Promise<CacheDb> = openCacheDb,
): TeamCache<CachedShortcut> {
  return createTeamCache(loadShortcuts, saveShortcuts, getCacheDb);
}

const SHORTCUT_NODE_TYPES: ReadonlySet<string> = new Set([
  "folder", "url", "team", "session", "external",
]);

/**
 * Shortcuts cache in the drawer's own `Shortcut` shape.
 *
 * The row and the domain type disagree on two names (`order` / `sortOrder`) and
 * on `target`, which is TEXT here and a URL string there. Both enums are
 * narrowed on read for the reason the other caches narrow theirs — an unknown
 * node type reads back as "url", the harmless leaf.
 */
export function createShortcutRowsCache(
  getCacheDb: () => Promise<CacheDb> = openCacheDb,
): TeamCache<Shortcut> {
  const rows = createShortcutsCache(getCacheDb);
  return {
    async load(teamId) {
      const cached = await rows.load(teamId);
      return (
        cached?.map((row) => ({
          id: row.id,
          label: row.label,
          icon: row.icon,
          nodeType: (SHORTCUT_NODE_TYPES.has(row.nodeType)
            ? row.nodeType
            : "url") as ShortcutNodeType,
          target: typeof row.target === "string" ? row.target : null,
          order: row.sortOrder,
          parentId: row.parentId,
          scope: (row.scope === "personal" ? "personal" : "team") as ShortcutScope,
        })) ?? null
      );
    },
    save: (teamId, shortcuts) =>
      rows.save(
        teamId,
        shortcuts.map((shortcut) => ({
          id: shortcut.id,
          teamId,
          scope: shortcut.scope,
          label: shortcut.label,
          icon: shortcut.icon,
          parentId: shortcut.parentId,
          target: shortcut.target,
          sortOrder: shortcut.order,
          nodeType: shortcut.nodeType,
        })),
      ),
  };
}
