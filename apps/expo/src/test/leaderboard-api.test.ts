import { describe, expect, it, vi } from "vitest";

import {
  createLeaderboardApi,
  toLeaderboardEntries,
} from "../features/actors/leaderboard-api";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("toLeaderboardEntries", () => {
  it("defaults missing numbers to 0 like iOS, and drops rows with no actor", () => {
    expect(
      toLeaderboardEntries([
        {
          actorId: "a",
          displayName: "Ada",
          tokensUsed: 1234.5,
          costUsd: 0.2,
          sessionCount: 3,
          positiveFeedback: 1,
          negativeFeedback: 0,
          skillUsage: { Read: 4, Bad: "x", Zero: 0 },
        },
        { actorId: "b" },
        { actorId: null, tokensUsed: 5 },
        null,
      ]),
    ).toEqual([
      {
        actorId: "a",
        displayName: "Ada",
        tokensUsed: 1234.5,
        costUsd: 0.2,
        sessionCount: 3,
        positiveFeedback: 1,
        negativeFeedback: 0,
        skillUsage: { Read: 4 },
      },
      {
        actorId: "b",
        displayName: null,
        tokensUsed: 0,
        costUsd: 0,
        sessionCount: 0,
        positiveFeedback: 0,
        negativeFeedback: 0,
        skillUsage: {},
      },
    ]);
  });
});

describe("createLeaderboardApi", () => {
  it("GETs /v1/teams/:id/leaderboard with the period", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ items: [{ actorId: "a", period: "day", score: 1, tokensUsed: 9 }] }),
    );
    const api = createLeaderboardApi({
      baseUrl: "https://fc.example.com",
      getAccessToken: async () => "tok",
      fetchImpl: fetchImpl as never,
    });

    const rows = await api.getLeaderboard("team 1", "day");

    expect(rows.map((row) => [row.actorId, row.tokensUsed])).toEqual([["a", 9]]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://fc.example.com/v1/teams/team%201/leaderboard?period=day",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("reads an empty page as no rows", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    const api = createLeaderboardApi({
      baseUrl: "https://fc.example.com",
      getAccessToken: async () => "tok",
      fetchImpl: fetchImpl as never,
    });
    await expect(api.getLeaderboard("t", "month")).resolves.toEqual([]);
  });
});
