import { describe, expect, it, vi } from "vitest";

import { parseInviteInput } from "../features/onboarding/invite-api";
import {
  createTeamJoinLinkApi,
  formatJoinLink,
  inferJoinLinkTtl,
  parseJoinLink,
  parseJoinLinkCap,
} from "../features/onboarding/join-link";
import { CloudApiError } from "../lib/cloud-api/client";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as Response;
}

const wireLink = {
  token: "tok",
  url: "https://api.acme.test/join/tok",
  expiresAt: "2026-10-20T00:00:00.000Z",
  maxUses: 5,
  useCount: 2,
  status: "active",
  createdAt: "2026-10-13T00:00:00.000Z",
};

describe("parseJoinLink (iOS InviteURL.parseJoinLink)", () => {
  it("reads an https join link and takes its origin as the Cloud API", () => {
    expect(parseJoinLink("https://api.acme.test/join/tok")).toEqual({
      token: "tok",
      cloudApiUrl: "https://api.acme.test",
    });
    expect(parseJoinLink("  http://localhost:8787/join/a%20b  ")).toEqual({
      token: "a b",
      cloudApiUrl: "http://localhost:8787",
    });
  });

  it("needs exactly one segment after /join", () => {
    expect(parseJoinLink("https://api.acme.test/join")).toBeNull();
    expect(parseJoinLink("https://api.acme.test/join/tok/extra")).toBeNull();
    expect(parseJoinLink("https://api.acme.test/invite/tok")).toBeNull();
  });

  it("reads the app-scheme form with an optional cloud_api_url", () => {
    expect(parseJoinLink("teamclu://join?token=tok")).toEqual({ token: "tok", cloudApiUrl: null });
    expect(
      parseJoinLink("amux://join?token=tok&cloud_api_url=https%3A%2F%2Fapi.acme.test"),
    ).toEqual({ token: "tok", cloudApiUrl: "https://api.acme.test" });
    expect(parseJoinLink("teamclaw://join")).toBeNull();
    expect(parseJoinLink("teamclu://invite?token=tok")).toBeNull();
    expect(parseJoinLink("bare-token")).toBeNull();
    expect(parseJoinLink("")).toBeNull();
  });

  it("is never read as a named invite token", () => {
    expect(parseInviteInput("teamclu://join?token=tok")).toBeNull();
    expect(parseInviteInput("https://api.acme.test/join/tok")).toBeNull();
  });

  it("round-trips through the stashed app-scheme form", () => {
    const parsed = parseJoinLink("https://api.acme.test/join/t%2Fk")!;
    expect(parseJoinLink(formatJoinLink(parsed))).toEqual(parsed);
    expect(parseJoinLink(formatJoinLink({ token: "x", cloudApiUrl: null }))).toEqual({
      token: "x",
      cloudApiUrl: null,
    });
  });
});

describe("join link form helpers", () => {
  it("parses the max-uses field like iOS parsedCap", () => {
    expect(parseJoinLinkCap("")).toEqual({ valid: true, value: null });
    expect(parseJoinLinkCap(" 12 ")).toEqual({ valid: true, value: 12 });
    expect(parseJoinLinkCap("0")).toEqual({ valid: false });
    expect(parseJoinLinkCap("-3")).toEqual({ valid: false });
    expect(parseJoinLinkCap("1.5")).toEqual({ valid: false });
    expect(parseJoinLinkCap("abc")).toEqual({ valid: false });
  });

  it("infers the term from expiry minus creation", () => {
    const createdAt = "2026-10-01T00:00:00.000Z";
    expect(inferJoinLinkTtl({ createdAt, expiresAt: null })).toBe("never");
    expect(inferJoinLinkTtl({ createdAt, expiresAt: "2026-10-08T00:00:05.000Z" })).toBe("7d");
    expect(inferJoinLinkTtl({ createdAt, expiresAt: "2026-10-31T00:00:00.000Z" })).toBe("30d");
  });
});

describe("createTeamJoinLinkApi", () => {
  const baseUrl = "https://fc.example.com";
  const getAccessToken = async () => "access-token";

  it("GETs the team's link and maps it", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(wireLink));
    const api = createTeamJoinLinkApi({ getAccessToken, baseUrl, fetchImpl: fetchImpl as never });

    await expect(api.get("team 1")).resolves.toEqual(wireLink);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://fc.example.com/v1/teams/team%201/join-link");
    expect(fetchImpl.mock.calls[0][1].method).toBe("GET");
  });

  it("treats 404 as no link", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { code: "not_found", message: "none" } }, 404));
    const api = createTeamJoinLinkApi({ getAccessToken, baseUrl, fetchImpl: fetchImpl as never });

    await expect(api.get("team-1")).resolves.toBeNull();
  });

  it("PUTs ttl, cap and rotate", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ...wireLink, maxUses: null }, 201));
    const api = createTeamJoinLinkApi({ getAccessToken, baseUrl, fetchImpl: fetchImpl as never });

    const link = await api.put("team-1", { ttl: "never", maxUses: null, rotate: true });

    expect(link.maxUses).toBeNull();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://fc.example.com/v1/teams/team-1/join-link");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ ttl: "never", maxUses: null, rotate: true });
  });

  it("surfaces upgrade_required on PUT as a coded error", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: { code: "upgrade_required", message: "upgrade" } }, 403),
      );
    const api = createTeamJoinLinkApi({ getAccessToken, baseUrl, fetchImpl: fetchImpl as never });

    await expect(api.put("team-1", { ttl: "7d", maxUses: null, rotate: false })).rejects.toMatchObject({
      code: "upgrade_required",
      status: 403,
    });
  });

  it("DELETEs to revoke", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(undefined, 204));
    const api = createTeamJoinLinkApi({ getAccessToken, baseUrl, fetchImpl: fetchImpl as never });

    await api.revoke("team-1");

    expect(fetchImpl.mock.calls[0][1].method).toBe("DELETE");
  });

  it("redeems against the link's own Cloud API with the same bearer", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ teamId: "t-joined", alreadyMember: false }));
    const api = createTeamJoinLinkApi({ getAccessToken, baseUrl, fetchImpl: fetchImpl as never });

    await expect(api.join("tok", "https://api.other.test/")).resolves.toEqual({
      teamId: "t-joined",
      alreadyMember: false,
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.other.test/v1/join-links/tok/join");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer access-token");
    expect(init.body).toBeUndefined();
  });

  it("turns a gone link into readable copy, keeping the code", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { code: "link_expired", message: "gone" } }, 410));
    const api = createTeamJoinLinkApi({ getAccessToken, baseUrl, fetchImpl: fetchImpl as never });

    const error = await api.join("tok").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CloudApiError);
    expect((error as CloudApiError).code).toBe("link_expired");
    expect((error as CloudApiError).message).toMatch(/expired|过期/);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://fc.example.com/v1/join-links/tok/join");
  });
});
