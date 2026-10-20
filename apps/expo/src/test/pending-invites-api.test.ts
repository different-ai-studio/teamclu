import { describe, expect, it, vi } from "vitest";

import { createInviteApi, toPendingInvites } from "../features/onboarding/invite-api";

const baseUrl = "https://fc.example.com";
const getAccessToken = async () => "access-token";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as Response;
}

function makeApi(fetchImpl: ReturnType<typeof vi.fn>) {
  return createInviteApi({ getAccessToken, baseUrl, fetchImpl: fetchImpl as never });
}

describe("toPendingInvites", () => {
  it("maps the wire rows and drops ones without routing keys", () => {
    expect(
      toPendingInvites([
        {
          inviteId: "inv-1",
          teamId: "team-1",
          teamName: "Alpha",
          teamRole: "member",
          invitedByDisplayName: "Ada",
        },
        { inviteId: "inv-2", teamId: "team-2", teamName: "  ", invitedByDisplayName: "" },
        { inviteId: null, teamId: "team-3" },
        { inviteId: "inv-4", teamId: null },
        null,
      ]),
    ).toEqual([
      {
        inviteId: "inv-1",
        teamId: "team-1",
        teamName: "Alpha",
        teamRole: "member",
        invitedByDisplayName: "Ada",
      },
      // Blank strings read as absent, so the UI falls back rather than
      // rendering an empty title or "Invited by ".
      {
        inviteId: "inv-2",
        teamId: "team-2",
        teamName: null,
        teamRole: null,
        invitedByDisplayName: null,
      },
    ]);
    expect(toPendingInvites(undefined)).toEqual([]);
  });
});

describe("createInviteApi pending invites", () => {
  it("lists GET /v1/invites/pending", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ items: [{ inviteId: "inv-1", teamId: "team-1", teamName: "Alpha" }] }),
    );
    const invites = await makeApi(fetchImpl).listPending();
    expect(invites).toEqual([
      {
        inviteId: "inv-1",
        teamId: "team-1",
        teamName: "Alpha",
        teamRole: null,
        invitedByDisplayName: null,
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://fc.example.com/v1/invites/pending",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("accepts via POST /v1/invites/:id/accept and returns the claim result", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        actorId: "actor-9",
        teamId: "team-9",
        actorType: "member",
        displayName: "Me",
        refreshToken: null,
      }),
    );
    await expect(makeApi(fetchImpl).acceptPending("inv/1")).resolves.toEqual({
      actorId: "actor-9",
      teamId: "team-9",
      actorType: "member",
      displayName: "Me",
      refreshToken: null,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://fc.example.com/v1/invites/inv%2F1/accept",
      expect.objectContaining({ method: "POST", body: undefined }),
    );
  });

  it("surfaces a 409 from accept (already a member / invite consumed)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { code: "conflict", message: "already a member" } }, 409),
    );
    await expect(makeApi(fetchImpl).acceptPending("inv-1")).rejects.toThrow(/already a member/);
  });

  it("declines via POST /v1/invites/:id/decline (204, no body)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(undefined, 204));
    await expect(makeApi(fetchImpl).declinePending("inv-1")).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://fc.example.com/v1/invites/inv-1/decline",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
