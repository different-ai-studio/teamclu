import { describe, expect, it, vi } from "vitest";

import { createIdeasApi } from "../features/ideas/idea-api";

function api(fetchImpl: ReturnType<typeof vi.fn>) {
  return createIdeasApi({
    baseUrl: "https://cloud.test",
    getAccessToken: async () => "tok",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("createIdeasApi", () => {
  it("listIdeas GETs the active bucket and enriches workspace names", async () => {
    const fetchImpl = vi.fn((url: string) => {
      if (url.startsWith("https://cloud.test/v1/ideas")) {
        return Promise.resolve(
          json({
            items: [
              {
                id: "i1",
                teamId: "t1",
                workspaceId: "w1",
                createdByActorId: "a1",
                title: "Ship it",
                description: "do the thing",
                status: "in_progress",
                archived: false,
                createdAt: "2026-05-01T00:00:00Z",
                updatedAt: "2026-05-02T00:00:00Z",
              },
            ],
            nextCursor: null,
          }),
        );
      }
      return Promise.resolve(json({ items: [{ id: "w1", name: "Repo" }], nextCursor: null }));
    });

    const ideas = await api(fetchImpl).listIdeas("t1");

    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://cloud.test/v1/ideas?teamId=t1&limit=200&archived=false",
    );
    expect(fetchImpl.mock.calls[1][0]).toBe("https://cloud.test/v1/workspaces?teamId=t1&limit=200");
    expect(ideas).toEqual([
      {
        ideaId: "i1",
        teamId: "t1",
        workspaceId: "w1",
        workspaceName: "Repo",
        createdByActorId: "a1",
        title: "Ship it",
        description: "do the thing",
        status: "in_progress",
        archived: false,
        sortOrder: 0,
        createdAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-05-02T00:00:00Z",
        attachmentUrls: [],
        commentCount: 0,
        likeCount: 0,
        likedByMe: false,
      },
    ]);
  });

  it("listIdeas follows the cursor and fetches both buckets when includeArchived", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn((url: string) => {
      calls.push(url);
      if (url.includes("/v1/ideas") && url.includes("archived=false") && !url.includes("cursor")) {
        return Promise.resolve(json({ items: [{ id: "i1", updatedAt: "b" }], nextCursor: "CUR" }));
      }
      if (url.includes("/v1/ideas") && url.includes("cursor=CUR")) {
        return Promise.resolve(json({ items: [{ id: "i2", updatedAt: "a" }], nextCursor: null }));
      }
      if (url.includes("/v1/ideas") && url.includes("archived=true")) {
        return Promise.resolve(json({ items: [{ id: "i3", updatedAt: "c" }], nextCursor: null }));
      }
      return Promise.resolve(json({ items: [], nextCursor: null }));
    });

    const ideas = await api(fetchImpl).listIdeas("t1", { includeArchived: true });

    // active bucket paginated (2 calls) + archived bucket (1 call); no workspace fetch (no workspaceIds).
    expect(calls.filter((u) => u.includes("/v1/ideas"))).toHaveLength(3);
    // merged + sorted by updatedAt desc: i3 (c), i1 (b), i2 (a)
    expect(ideas.map((i) => i.ideaId)).toEqual(["i3", "i1", "i2"]);
  });

  it("updateStatus PATCHes the status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await api(fetchImpl).updateStatus("i1", "done");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://cloud.test/v1/ideas/i1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ status: "done" });
  });

  it("updateContent PATCHes only provided fields", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await api(fetchImpl).updateContent("i1", { title: "New" });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ title: "New" });
  });

  it("archive / unarchive POST the archive endpoint with the flag", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const ideas = api(fetchImpl);
    await ideas.archive("i1");
    await ideas.unarchive("i1");
    expect(fetchImpl.mock.calls[0][0]).toBe("https://cloud.test/v1/ideas/i1/archive");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ archived: true });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ archived: false });
  });

  it("listActivities normalises both the pg (kind) and Supabase (activityType) shapes", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json({
        items: [
          {
            id: "act2",
            ideaId: "i1",
            actorId: "a1",
            kind: "status_change",
            content: "Changed status from Open to Done",
            metadata: { from_status: "open", to_status: "done" },
            createdAt: "2026-05-03T00:00:00Z",
          },
          {
            id: "act1",
            teamId: "t1",
            ideaId: "i1",
            actorId: "a2",
            activityType: "progress",
            content: "Pushed a fix",
            metadata: null,
            attachmentUrls: ["https://cdn.test/a.jpg"],
            createdAt: "2026-05-02T00:00:00Z",
            updatedAt: "2026-05-02T00:00:00Z",
          },
        ],
      }),
    );

    const activities = await api(fetchImpl).listActivities("i1");

    expect(fetchImpl.mock.calls[0][0]).toBe("https://cloud.test/v1/ideas/i1/activities");
    expect(activities).toEqual([
      {
        id: "act2",
        ideaId: "i1",
        teamId: "",
        actorId: "a1",
        activityType: "status_change",
        content: "Changed status from Open to Done",
        metadata: { from_status: "open", to_status: "done" },
        attachmentUrls: [],
        createdAt: "2026-05-03T00:00:00Z",
        updatedAt: "2026-05-03T00:00:00Z",
      },
      {
        id: "act1",
        ideaId: "i1",
        teamId: "t1",
        actorId: "a2",
        activityType: "progress",
        content: "Pushed a fix",
        metadata: {},
        attachmentUrls: ["https://cdn.test/a.jpg"],
        createdAt: "2026-05-02T00:00:00Z",
        updatedAt: "2026-05-02T00:00:00Z",
      },
    ]);
  });

  it("createActivity POSTs the iOS wire shape and trims the content", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json({ id: "act1", ideaId: "i1", actorId: "a1", kind: "progress", createdAt: "t" }),
    );

    await api(fetchImpl).createActivity("i1", {
      activityType: "progress",
      content: "  shipped  ",
      actorId: "a1",
      attachmentUrls: ["https://cdn.test/a.jpg"],
    });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://cloud.test/v1/ideas/i1/activities");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      kind: "progress",
      content: "shipped",
      actorId: "a1",
      metadata: {},
      attachmentUrls: ["https://cdn.test/a.jpg"],
    });
  });

  it("reorderIdeas POSTs the ordered id list and no-ops when empty", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const ideas = api(fetchImpl);

    await ideas.reorderIdeas("t1", []);
    expect(fetchImpl).not.toHaveBeenCalled();

    await ideas.reorderIdeas("t1", ["i2", "i1"]);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://cloud.test/v1/ideas/reorder");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      teamId: "t1",
      ideaIds: ["i2", "i1"],
    });
  });

  it("listIdeas maps the feed fields: pictures, comment/like counts, likedByMe", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json({
        items: [
          {
            id: "i1",
            teamId: "t1",
            title: "Pic post",
            attachmentUrls: ["https://cdn.test/a.jpg", "", "https://cdn.test/b.jpg"],
            commentCount: 3,
            likeCount: 5,
            likedByMe: true,
          },
          { id: "i2", teamId: "t1", title: "Bare", likeCount: -1, likedByMe: null },
        ],
        nextCursor: null,
      }),
    );

    const [first, second] = await api(fetchImpl).listIdeas("t1");

    expect(first).toMatchObject({
      ideaId: "i1",
      attachmentUrls: ["https://cdn.test/a.jpg", "https://cdn.test/b.jpg"],
      commentCount: 3,
      likeCount: 5,
      likedByMe: true,
    });
    // Absent or nonsense counts read as zero, never negative.
    expect(second).toMatchObject({
      ideaId: "i2",
      attachmentUrls: [],
      commentCount: 0,
      likeCount: 0,
      likedByMe: false,
    });
  });

  it("setLike PUTs the desired state (not a toggle) and returns the server's answer", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ likeCount: 4, likedByMe: true }));

    const state = await api(fetchImpl).setLike("i 1", true);

    expect(fetchImpl.mock.calls[0][0]).toBe("https://cloud.test/v1/ideas/i%201/like");
    expect(fetchImpl.mock.calls[0][1].method).toBe("PUT");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ liked: true });
    expect(state).toEqual({ likeCount: 4, likedByMe: true });
  });

  it("createIdea posts the pictures with the idea and maps them back", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json({ id: "i1", teamId: "t1", title: "T", attachmentUrls: ["https://cdn.test/a.jpg"] }),
    );

    const idea = await api(fetchImpl).createIdea({
      teamId: "t1",
      title: "T",
      attachmentUrls: ["https://cdn.test/a.jpg"],
    });

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      attachmentUrls: ["https://cdn.test/a.jpg"],
    });
    expect(idea.attachmentUrls).toEqual(["https://cdn.test/a.jpg"]);
  });
});
