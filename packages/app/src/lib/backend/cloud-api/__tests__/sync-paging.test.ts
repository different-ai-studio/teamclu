import { describe, expect, it, vi } from "vitest";
import type { CloudApiClient } from "@/lib/backend/cloud-api/http";
import { fetchAllSyncPages } from "@/lib/backend/cloud-api/sync-paging";
import { createSyncModule } from "@/lib/backend/cloud-api/sync";
import { createSessionsModule } from "@/lib/backend/cloud-api/sessions";
import { createMessagesModule } from "@/lib/backend/cloud-api/messages";

/**
 * A client that serves a scripted list of pages in order and records the paths
 * it was asked for.
 */
function pagingClient(pages: Array<{ items: unknown[]; nextCursor: string | null }>) {
  const paths: string[] = [];
  let next = 0;
  return {
    paths,
    client: {
      async get(path: string) {
        paths.push(path);
        const page = pages[next] ?? { items: [], nextCursor: null };
        next += 1;
        return page as never;
      },
      async post() { throw new Error("unexpected post"); },
      async patch() { throw new Error("unexpected patch"); },
      async put() { throw new Error("unexpected put"); },
      async delete() { throw new Error("unexpected delete"); },
      async postRaw() { throw new Error("not impl"); },
      async getRaw() { throw new Error("not impl"); },
    } as unknown as CloudApiClient,
  };
}

describe("fetchAllSyncPages", () => {
  it("follows nextCursor to exhaustion and concatenates every page", async () => {
    const { client, paths } = pagingClient([
      { items: [{ id: "a" }, { id: "b" }], nextCursor: "cur-1" },
      { items: [{ id: "c" }], nextCursor: "cur-2" },
      { items: [{ id: "d" }], nextCursor: null },
    ]);

    const rows = await fetchAllSyncPages<{ id: string }>(client, "/v1/sync/ideas", {
      teamId: "team-1",
      since: null,
    });

    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(paths).toHaveLength(3);
    // The first request carries no cursor; each later one carries the previous
    // page's, so no row is skipped or repeated across the boundary.
    expect(paths[0]).not.toContain("cursor=");
    expect(paths[1]).toContain("cursor=cur-1");
    expect(paths[2]).toContain("cursor=cur-2");
  });

  it("stops when a page reports no cursor, even if it is full", async () => {
    const { client, paths } = pagingClient([{ items: [{ id: "only" }], nextCursor: null }]);

    const rows = await fetchAllSyncPages<{ id: string }>(client, "/v1/sync/ideas", { teamId: "t" });

    expect(rows).toHaveLength(1);
    expect(paths).toHaveLength(1);
  });

  it("omits empty params but always sends a limit", async () => {
    const { client, paths } = pagingClient([{ items: [], nextCursor: null }]);

    await fetchAllSyncPages(client, "/v1/sync/messages", { sessionId: "s-1", since: null });

    expect(paths[0]).toContain("sessionId=s-1");
    expect(paths[0]).not.toContain("since=");
    expect(paths[0]).toContain("limit=");
  });

  it("warns and stops rather than looping forever on an endless cursor", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Every page reports another cursor.
    const endless = Array.from({ length: 1200 }, () => ({
      items: [{ id: "x" }],
      nextCursor: "always",
    }));
    const { client, paths } = pagingClient(endless);

    const rows = await fetchAllSyncPages<{ id: string }>(client, "/v1/sync/ideas", { teamId: "t" });

    expect(paths.length).toBe(1000);
    expect(rows).toHaveLength(1000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("incomplete"));
    warn.mockRestore();
  });
});

// Regression: every sync reader must page. listSessionsForTeamSince in
// particular hit a live server that already paginated at 50 while this client
// read only the first response, so large deltas were silently truncated.
describe("sync readers page to exhaustion", () => {
  const twoPages = () =>
    pagingClient([
      { items: [{ id: "1" }], nextCursor: "c1" },
      { items: [{ id: "2" }], nextCursor: null },
    ]);

  it("listSessionsForTeamSince", async () => {
    const { client } = twoPages();
    const rows = await createSessionsModule(client).listSessionsForTeamSince("team-1", null);
    expect(rows).toHaveLength(2);
  });

  it("listMessagesForSessionSince", async () => {
    const { client } = twoPages();
    const rows = await createMessagesModule(client).listMessagesForSessionSince("session-1", null);
    expect(rows).toHaveLength(2);
  });

  it("listActorDirectoryForSync", async () => {
    const { client } = twoPages();
    const rows = await createSyncModule(client).listActorDirectoryForSync("team-1", null);
    expect(rows).toHaveLength(2);
  });

  it("listIdeasForSync", async () => {
    const { client } = twoPages();
    const rows = await createSyncModule(client).listIdeasForSync("team-1", null);
    expect(rows).toHaveLength(2);
  });

  it("listSessionParticipantsForSync", async () => {
    const { client } = twoPages();
    const rows = await createSyncModule(client).listSessionParticipantsForSync("session-1", null);
    expect(rows).toHaveLength(2);
  });
});
