import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createActorsCache,
  createIdeasCache,
  createShortcutRowsCache,
  createShortcutsCache,
  createWorkspacesCache,
  toCachedIdea,
} from "../lib/db/team-cache";
import { clearTeamCache } from "../lib/db/local-cache";
import type { Actor } from "../features/actors/actor-types";
import type { Idea } from "../features/ideas/idea-types";
import { createMemoryCacheDb } from "./helpers/memory-db";

function idea(partial: Partial<Idea> = {}): Idea {
  return {
    ideaId: "i1",
    teamId: "t1",
    workspaceId: null,
    workspaceName: null,
    createdByActorId: "a1",
    title: "Idea",
    description: "",
    status: "open",
    archived: false,
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    attachmentUrls: [],
    commentCount: 0,
    likeCount: 0,
    likedByMe: false,
    ...partial,
  };
}

function actor(partial: Partial<Actor> = {}): Actor {
  return {
    actorId: "a1",
    teamId: "t1",
    actorType: "member",
    displayName: "Ada",
    role: "owner",
    lastActiveAt: null,
    avatarUrl: null,
    agentTypes: [],
    defaultAgentType: null,
    agentKind: null,
    ...partial,
  };
}

let db: ReturnType<typeof createMemoryCacheDb>;

beforeEach(() => {
  db = createMemoryCacheDb();
});

afterEach(() => {
  db.close();
});

describe("ideas cache", () => {
  const cache = () => createIdeasCache(async () => db);

  it("returns null before anything is cached", async () => {
    expect(await cache().load("t1")).toBeNull();
  });

  it("round-trips an idea", async () => {
    await cache().save("t1", [idea({ status: "in_progress", sortOrder: 3 })]);
    const loaded = await cache().load("t1");
    expect(loaded).toEqual([idea({ status: "in_progress", sortOrder: 3 })]);
  });

  it("narrows an unrecognised status instead of leaking it to the UI", async () => {
    // SQLite has no enums, so an older build (or a hand edit) can leave
    // anything in the column.
    await db.runAsync(
      `INSERT INTO cached_ideas (idea_id, team_id, title, status, cached_at)
       VALUES ('i9', 't1', 'Legacy', 'archived_v0', 0)`,
    );
    expect((await cache().load("t1"))?.[0]?.status).toBe("open");
  });

  it("orders by sort order, then most recently updated", async () => {
    await cache().save("t1", [
      idea({ ideaId: "b", sortOrder: 2, updatedAt: "2026-01-01T00:00:00Z" }),
      idea({ ideaId: "a", sortOrder: 1, updatedAt: "2026-01-01T00:00:00Z" }),
      idea({ ideaId: "c", sortOrder: 2, updatedAt: "2026-06-01T00:00:00Z" }),
    ]);
    expect((await cache().load("t1"))?.map((i) => i.ideaId)).toEqual(["a", "c", "b"]);
  });

  it("never persists feed counts or likedByMe", async () => {
    // A stale count shown offline is worse than none (iOS parity): the
    // round-trip drops them and they fill in when the refresh lands.
    await cache().save("t1", [
      idea({ commentCount: 4, likeCount: 7, likedByMe: true, attachmentUrls: ["https://x/a.png"] }),
    ]);
    const raw = await db.getAllAsync("SELECT * FROM cached_ideas WHERE team_id = ?", "t1");
    expect(raw).toHaveLength(1);
    const columns = Object.keys(raw[0] as Record<string, unknown>);
    expect(columns.some((c) => /like|comment/i.test(c))).toBe(false);
    const loaded = await cache().load("t1");
    expect(loaded?.[0]).toMatchObject({ commentCount: 0, likeCount: 0, likedByMe: false });
  });

  it("toCachedIdea strips the feed-only fields", () => {
    const cached = toCachedIdea(
      idea({ commentCount: 2, likeCount: 3, likedByMe: true, attachmentUrls: ["u"] }),
    );
    expect(cached).not.toHaveProperty("commentCount");
    expect(cached).not.toHaveProperty("likeCount");
    expect(cached).not.toHaveProperty("likedByMe");
    expect(cached).not.toHaveProperty("attachmentUrls");
    expect(cached.ideaId).toBe("i1");
  });

  it("keeps teams apart", async () => {
    await cache().save("t1", [idea({ ideaId: "i1", teamId: "t1" })]);
    await cache().save("t2", [idea({ ideaId: "i2", teamId: "t2" })]);
    expect((await cache().load("t1"))?.map((i) => i.ideaId)).toEqual(["i1"]);
    expect((await cache().load("t2"))?.map((i) => i.ideaId)).toEqual(["i2"]);
  });
});

describe("actors cache", () => {
  const cache = () => createActorsCache(async () => db);

  it("round-trips a member and an agent", async () => {
    await cache().save("t1", [
      actor({ actorId: "a1", actorType: "member" }),
      actor({
        actorId: "a2",
        actorType: "agent",
        displayName: "Claude",
        agentTypes: ["claude", "opencode"],
        defaultAgentType: "claude",
        visibility: "personal",
      }),
    ]);
    const loaded = await cache().load("t1");
    expect(loaded?.map((a) => a.actorType)).toEqual(["member", "agent"]);
    expect(loaded?.find((a) => a.actorId === "a2")?.agentTypes).toEqual([
      "claude",
      "opencode",
    ]);
    expect(loaded?.find((a) => a.actorId === "a2")?.visibility).toBe("personal");
  });

  it("narrows an unrecognised actor type to member", async () => {
    await db.runAsync(
      `INSERT INTO cached_actors (actor_id, team_id, actor_type, display_name, cached_at)
       VALUES ('a9', 't1', 'robot', 'Legacy', 0)`,
    );
    expect((await cache().load("t1"))?.[0]?.actorType).toBe("member");
  });

  it("survives a round trip through the optional fields", async () => {
    await cache().save("t1", [
      actor({ email: "ada@example.test", phone: null, memberStatus: "invited" }),
    ]);
    const loaded = await cache().load("t1");
    expect(loaded?.[0]?.email).toBe("ada@example.test");
    expect(loaded?.[0]?.memberStatus).toBe("invited");
  });
});

describe("workspaces and shortcuts caches", () => {
  it("round-trip their rows", async () => {
    const workspaces = createWorkspacesCache(async () => db);
    const shortcuts = createShortcutsCache(async () => db);
    await workspaces.save("t1", [
      { id: "w1", teamId: "t1", name: "repo", path: "/tmp/repo", agentId: "a2", archived: false },
    ]);
    await shortcuts.save("t1", [
      { id: "s1", teamId: "t1", scope: "team", label: "Docs", icon: null, parentId: null, target: "https://example.test", sortOrder: 0, nodeType: "url" },
    ]);
    expect((await workspaces.load("t1"))?.[0]?.name).toBe("repo");
    expect((await shortcuts.load("t1"))?.[0]?.label).toBe("Docs");
  });

  it("keeps folders distinguishable from links", async () => {
    // Without node_type (added in migration 4) every restored row reads as a
    // leaf, and the drawer cannot rebuild its tree.
    const shortcuts = createShortcutRowsCache(async () => db);
    await shortcuts.save("t1", [
      { id: "f1", label: "Folder", icon: null, nodeType: "folder", target: null, order: 0, parentId: null, scope: "team" },
      { id: "l1", label: "Link", icon: null, nodeType: "url", target: "https://example.test", order: 1, parentId: "f1", scope: "team" },
    ]);
    const loaded = await shortcuts.load("t1");
    expect(loaded?.map((row) => row.nodeType)).toEqual(["folder", "url"]);
    expect(loaded?.[1]?.parentId).toBe("f1");
    expect(loaded?.[1]?.target).toBe("https://example.test");
  });

  it("defaults a pre-migration-4 row to a leaf rather than failing to read it", async () => {
    const shortcuts = createShortcutRowsCache(async () => db);
    await db.runAsync(
      `INSERT INTO cached_shortcuts (shortcut_id, team_id, label, cached_at)
       VALUES ('old', 't1', 'Legacy', 0)`,
    );
    expect((await shortcuts.load("t1"))?.[0]?.nodeType).toBe("url");
  });
});

describe("clearTeamCache", () => {
  it("drops every scope for one team and leaves the other alone", async () => {
    const ideas = createIdeasCache(async () => db);
    const actors = createActorsCache(async () => db);
    await ideas.save("t1", [idea({ teamId: "t1" })]);
    await actors.save("t1", [actor({ teamId: "t1" })]);
    await ideas.save("t2", [idea({ ideaId: "i2", teamId: "t2" })]);

    await clearTeamCache(db, "t1");

    expect(await ideas.load("t1")).toBeNull();
    expect(await actors.load("t1")).toBeNull();
    expect((await ideas.load("t2"))?.length).toBe(1);
  });
});
