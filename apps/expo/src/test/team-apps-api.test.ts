import { describe, expect, it, vi } from "vitest";

import {
  TeamAppNameRequiredError,
  TeamAppNotFoundError,
  buildCreateTeamAppBody,
  createTeamAppsApi,
  toTeamApp,
  toTeamAppSession,
} from "../features/apps/team-apps-api";

function api(fetchImpl: ReturnType<typeof vi.fn>) {
  return createTeamAppsApi({
    baseUrl: "https://cloud.test",
    getAccessToken: async () => "tok",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

const WIRE_APP = {
  id: "app-1",
  teamId: "team-1",
  createdByActorId: "actor-1",
  name: "Weekly board",
  slug: "weekly-board",
  type: "data_app",
  visibility: "team",
  provisionStatus: "ready",
  fcStatus: "live",
  publicUrl: "https://weekly-board.apps.example.com",
  fcEndpoint: "https://fc.example.com/fn",
  gitRemoteUrl: "ssh://git@gitea.example.com/t/weekly-board.git",
  gitAuthKind: "gitea_deploy_key",
  relationship: "owner",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-02T00:00:00Z",
  // Fields this client ignores must not break the mapping.
  authMode: "team",
  customDomain: null,
};

describe("createTeamAppsApi", () => {
  it("listApps GETs /v1/apps with teamId and limit=100, bearer auth, and maps rows", async () => {
    const fetchImpl = vi.fn(async () => json({ items: [WIRE_APP] }));

    const apps = await api(fetchImpl).listApps("team 1");

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cloud.test/v1/apps?teamId=team%201&limit=100");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(apps).toEqual([
      {
        id: "app-1",
        teamId: "team-1",
        createdByActorId: "actor-1",
        name: "Weekly board",
        slug: "weekly-board",
        type: "data_app",
        visibility: "team",
        provisionStatus: "ready",
        fcStatus: "live",
        publicUrl: "https://weekly-board.apps.example.com",
        fcEndpoint: "https://fc.example.com/fn",
        gitRemoteUrl: "ssh://git@gitea.example.com/t/weekly-board.git",
        gitAuthKind: "gitea_deploy_key",
        relationship: "owner",
        createdAt: "2026-09-01T00:00:00Z",
        updatedAt: "2026-09-02T00:00:00Z",
      },
    ]);
  });

  it("listApps tolerates a missing items array", async () => {
    const fetchImpl = vi.fn(async () => json({}));
    expect(await api(fetchImpl).listApps("t")).toEqual([]);
  });

  it("getApp GETs /v1/apps/{id} with the id encoded", async () => {
    const fetchImpl = vi.fn(async () => json(WIRE_APP));
    const app = await api(fetchImpl).getApp("a/b");
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://cloud.test/v1/apps/a%2Fb");
    expect(app.id).toBe("app-1");
  });

  it("getApp turns a 404 into TeamAppNotFoundError", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ error: { code: "not_found", message: "App not found" } }, 404),
    );
    await expect(api(fetchImpl).getApp("x")).rejects.toBeInstanceOf(TeamAppNotFoundError);
  });

  it("getApp passes other errors through", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ error: { code: "internal", message: "boom" } }, 500),
    );
    await expect(api(fetchImpl).getApp("x")).rejects.toThrow("boom");
  });

  it("createApp POSTs a trimmed name, type and visibility", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ ...WIRE_APP, provisionStatus: "repo_created", fcStatus: null, publicUrl: null }, 201),
    );

    const app = await api(fetchImpl).createApp("team-1", {
      name: "  Weekly board  ",
      type: "slides",
      visibility: "personal",
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cloud.test/v1/apps");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      teamId: "team-1",
      name: "Weekly board",
      type: "slides",
      visibility: "personal",
    });
    expect(app.provisionStatus).toBe("repo_created");
    expect(app.fcStatus).toBeNull();
  });

  it("createApp rejects a blank name without calling the server", async () => {
    const fetchImpl = vi.fn();
    await expect(
      api(fetchImpl).createApp("team-1", { name: "   ", type: "static_web", visibility: "team" }),
    ).rejects.toBeInstanceOf(TeamAppNameRequiredError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("listAppSessions GETs /v1/apps/{id}/sessions and maps rows", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        items: [
          {
            id: "s1",
            teamId: "team-1",
            title: "Fix the chart",
            mode: "collab",
            lastMessageAt: "2026-09-03T00:00:00Z",
            createdAt: "2026-09-01T00:00:00Z",
            updatedAt: "2026-09-02T00:00:00Z",
          },
        ],
      }),
    );

    const sessions = await api(fetchImpl).listAppSessions("app-1");

    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://cloud.test/v1/apps/app-1/sessions");
    expect(sessions).toEqual([
      {
        id: "s1",
        teamId: "team-1",
        title: "Fix the chart",
        mode: "collab",
        lastMessageAt: "2026-09-03T00:00:00Z",
        createdAt: "2026-09-01T00:00:00Z",
        updatedAt: "2026-09-02T00:00:00Z",
      },
    ]);
  });
});

describe("toTeamApp", () => {
  it("falls back conservatively on unknown or missing enum values", () => {
    const app = toTeamApp({
      id: "x",
      type: "something_new",
      visibility: null,
      provisionStatus: "weird",
      fcStatus: "also_weird",
      relationship: undefined,
    });
    expect(app.type).toBe("imported");
    expect(app.visibility).toBe("personal");
    expect(app.provisionStatus).toBe("pending");
    expect(app.fcStatus).toBeNull();
    expect(app.relationship).toBe("team");
    expect(app.name).toBe("");
    expect(app.slug).toBe("");
    expect(app.createdAt).toBe("");
  });

  it("uses createdAt when updatedAt is absent", () => {
    expect(toTeamApp({ id: "x", createdAt: "2026-01-01T00:00:00Z" }).updatedAt).toBe(
      "2026-01-01T00:00:00Z",
    );
  });
});

describe("toTeamAppSession", () => {
  it("fills blanks for optional fields", () => {
    expect(toTeamAppSession({ id: "s" })).toEqual({
      id: "s",
      teamId: "",
      title: "",
      mode: "",
      lastMessageAt: null,
      createdAt: "",
      updatedAt: "",
    });
  });
});

describe("buildCreateTeamAppBody", () => {
  it("throws on a whitespace-only name", () => {
    expect(() =>
      buildCreateTeamAppBody("t", { name: "\n ", type: "static_web", visibility: "personal" }),
    ).toThrow(TeamAppNameRequiredError);
  });
});
