import { describe, expect, it } from "vitest";

import {
  CREATABLE_TEAM_APP_TYPES,
  TEAM_APP_FILTERS,
  filterTeamApps,
  teamAppFilterLabelKey,
  teamAppNeedsDesktopSetup,
  teamAppOpenableUrl,
  teamAppSessionTitle,
  teamAppSourceLabelKey,
  teamAppStatusDot,
  teamAppStatusKind,
  teamAppStatusLabelKey,
  teamAppTypeLabelKey,
  teamAppVisibilityLabelKey,
  type TeamApp,
} from "../features/apps/team-app-types";

function app(overrides: Partial<TeamApp> = {}): TeamApp {
  return {
    id: "a",
    teamId: "t",
    createdByActorId: null,
    name: "App",
    slug: "app",
    type: "static_web",
    visibility: "personal",
    provisionStatus: "ready",
    fcStatus: null,
    publicUrl: null,
    fcEndpoint: null,
    gitRemoteUrl: null,
    gitAuthKind: null,
    relationship: "team",
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

describe("teamAppOpenableUrl", () => {
  it("prefers the public URL over the function endpoint", () => {
    expect(
      teamAppOpenableUrl({ publicUrl: "https://pub.example.com", fcEndpoint: "https://fc.example.com" }),
    ).toBe("https://pub.example.com");
    expect(teamAppOpenableUrl({ publicUrl: null, fcEndpoint: "https://fc.example.com" })).toBe(
      "https://fc.example.com",
    );
    expect(teamAppOpenableUrl({ publicUrl: "  ", fcEndpoint: null })).toBeNull();
  });

  it("refuses anything that is not http(s)", () => {
    expect(teamAppOpenableUrl({ publicUrl: "javascript:alert(1)", fcEndpoint: null })).toBeNull();
    expect(teamAppOpenableUrl({ publicUrl: "not a url", fcEndpoint: null })).toBeNull();
  });
});

describe("teamAppNeedsDesktopSetup", () => {
  it("is true until provisioning reaches ready or error", () => {
    expect(teamAppNeedsDesktopSetup({ provisionStatus: "pending" })).toBe(true);
    expect(teamAppNeedsDesktopSetup({ provisionStatus: "repo_created" })).toBe(true);
    expect(teamAppNeedsDesktopSetup({ provisionStatus: "seeding" })).toBe(true);
    expect(teamAppNeedsDesktopSetup({ provisionStatus: "ready" })).toBe(false);
    expect(teamAppNeedsDesktopSetup({ provisionStatus: "error" })).toBe(false);
  });
});

describe("status", () => {
  const cases: Array<[Partial<TeamApp>, string, string]> = [
    [{ fcStatus: "live", publicUrl: "https://x.example.com" }, "live", "Deployed"],
    // Live without an address falls through to provisioning.
    [{ fcStatus: "live", provisionStatus: "ready" }, "idle", "Not deployed"],
    [{ fcStatus: "deploy_error" }, "failed", "Deploy failed"],
    [{ fcStatus: "awaiting_build" }, "working", "Deploying…"],
    [{ fcStatus: "building" }, "working", "Deploying…"],
    [{ fcStatus: "deploying" }, "working", "Deploying…"],
    [{ fcStatus: "not_deployed", provisionStatus: "ready" }, "idle", "Not deployed"],
    [{ fcStatus: null, provisionStatus: "error" }, "failed", "Setup failed"],
    [{ fcStatus: null, provisionStatus: "repo_created" }, "pending", "Not initialized"],
    [{ fcStatus: null, provisionStatus: "pending" }, "pending", "Not initialized"],
  ];

  it.each(cases)("%j → %s / %s", (overrides, kind, label) => {
    expect(teamAppStatusKind(app(overrides))).toBe(kind);
    expect(teamAppStatusLabelKey(app(overrides))).toBe(label);
  });

  it("maps kinds onto the StatusDot atom; only live breathes", () => {
    expect(teamAppStatusDot("live")).toEqual({ kind: "active", basalt: false, breathing: true });
    expect(teamAppStatusDot("failed")).toEqual({ kind: "error", basalt: false, breathing: false });
    expect(teamAppStatusDot("working")).toEqual({ kind: "idle", basalt: true, breathing: false });
    expect(teamAppStatusDot("pending")).toEqual({ kind: "idle", basalt: false, breathing: false });
    expect(teamAppStatusDot("idle")).toEqual({ kind: "idle", basalt: false, breathing: false });
  });
});

describe("labels", () => {
  it("names the code source in the reader's terms", () => {
    expect(teamAppSourceLabelKey({ gitAuthKind: "gitea_deploy_key", gitRemoteUrl: "ssh://x" })).toBe(
      "Managed repo",
    );
    expect(teamAppSourceLabelKey({ gitAuthKind: null, gitRemoteUrl: "https://github.com/o/r" })).toBe(
      "External repo",
    );
    expect(teamAppSourceLabelKey({ gitAuthKind: null, gitRemoteUrl: "  " })).toBe(
      "This computer only",
    );
  });

  it("labels types, visibility and filters", () => {
    expect(CREATABLE_TEAM_APP_TYPES.map(teamAppTypeLabelKey)).toEqual([
      "Static web page",
      "Slides",
      "Data app",
    ]);
    expect(teamAppTypeLabelKey("fullstack_tanstack_postgres")).toBe("Full-stack app");
    expect(teamAppVisibilityLabelKey("team")).toBe("Whole team");
    expect(teamAppVisibilityLabelKey("personal")).toBe("Only me and people I invite");
    expect(TEAM_APP_FILTERS.map(teamAppFilterLabelKey)).toEqual([
      "All",
      "Created by me",
      "Shared with me",
      "Team's",
    ]);
  });

  it("gives blank session titles a placeholder key", () => {
    expect(teamAppSessionTitle({ title: "  " })).toEqual({
      text: "Untitled session",
      isPlaceholder: true,
    });
    expect(teamAppSessionTitle({ title: " Fix " })).toEqual({ text: "Fix", isPlaceholder: false });
  });
});

describe("filterTeamApps", () => {
  const rows = [
    app({ id: "1", relationship: "owner" }),
    app({ id: "2", relationship: "team" }),
    app({ id: "3", relationship: "invited" }),
    app({ id: "4", relationship: "owner" }),
  ];

  it("keeps everything, in server order, for all", () => {
    expect(filterTeamApps(rows, "all").map((a) => a.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("filters by relationship", () => {
    expect(filterTeamApps(rows, "owner").map((a) => a.id)).toEqual(["1", "4"]);
    expect(filterTeamApps(rows, "invited").map((a) => a.id)).toEqual(["3"]);
    expect(filterTeamApps(rows, "team").map((a) => a.id)).toEqual(["2"]);
  });
});
