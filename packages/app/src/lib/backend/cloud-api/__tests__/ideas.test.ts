import { describe, expect, it, vi } from "vitest";
import { createIdeasModule } from "@/lib/backend/cloud-api/ideas";
import type { CloudApiClient } from "@/lib/backend/cloud-api/http";

function mockClient(responses: Record<string, unknown>) {
  const post = vi.fn(async (path: string, _body?: unknown) => {
    const key = `POST ${path}`;
    if (key in responses) return responses[key] as never;
    throw new Error(`unexpected POST ${path}`);
  });
  const client = {
    async get(path: string) {
      const key = `GET ${path}`;
      if (key in responses) return responses[key] as never;
      throw new Error(`unexpected GET ${path}`);
    },
    post,
    async patch() {
      return undefined as never;
    },
  } as unknown as CloudApiClient;
  return { client, post };
}

describe("getIdeaDetail", () => {
  it("composes the idea row with its activities and actor names", async () => {
    const { client, post } = mockClient({
      "GET /v1/ideas/idea-1": {
        id: "idea-1",
        teamId: "team-1",
        title: "Launch beta",
        description: "Ship it.",
        status: "in_progress",
        createdByActorId: "actor-1",
        updatedAt: "2026-05-11T00:00:00Z",
        sortOrder: 1000,
      },
      "GET /v1/ideas/idea-1/activities": {
        items: [
          {
            id: "act-1",
            ideaId: "idea-1",
            actorId: "actor-2",
            kind: "progress",
            content: "Started.",
            createdAt: "2026-05-11T00:00:00Z",
          },
        ],
      },
      "POST /v1/actors/by-ids": {
        items: [
          { id: "actor-1", kind: "member", displayName: "Alice" },
          { id: "actor-2", kind: "agent", displayName: "Bot" },
        ],
      },
    });

    const detail = await createIdeasModule(client).getIdeaDetail("idea-1");

    expect(post).toHaveBeenCalledWith("/v1/actors/by-ids", { actorIds: ["actor-1", "actor-2"] });
    expect(detail).toMatchObject({
      id: "idea-1",
      title: "Launch beta",
      activities: [
        { id: "act-1", actor_id: "actor-2", activity_type: "progress", content: "Started." },
      ],
      actors: [
        { id: "actor-1", display_name: "Alice", actor_type: "member" },
        { id: "actor-2", display_name: "Bot", actor_type: "agent" },
      ],
    });
  })

  it("skips the actors lookup when nothing references an actor", async () => {
    const { client, post } = mockClient({
      "GET /v1/ideas/idea-1": { id: "idea-1", teamId: "team-1", title: "Untracked" },
      "GET /v1/ideas/idea-1/activities": { items: [] },
    });

    const detail = await createIdeasModule(client).getIdeaDetail("idea-1");

    expect(post).not.toHaveBeenCalled();
    expect(detail).toMatchObject({ id: "idea-1", activities: [], actors: [] });
  })

  it("returns null when the activities fetch fails", async () => {
    const { client } = mockClient({
      "GET /v1/ideas/idea-1": { id: "idea-1", teamId: "team-1", title: "Broken" },
    });

    expect(await createIdeasModule(client).getIdeaDetail("idea-1")).toBeNull();
  })
})
