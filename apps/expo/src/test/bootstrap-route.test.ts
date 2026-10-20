import { describe, expect, it } from "vitest";

import {
  resolveBootstrapDecision,
  resolveBootstrapLanding,
  scopeToHomeOrg,
  type BootstrapTeam,
} from "../features/onboarding/bootstrap-route";

describe("resolveBootstrapDecision with homeOrgId (#1585)", () => {
  const inOrg = (id: string, orgId: string): BootstrapTeam => ({
    id,
    name: id,
    slug: id,
    role: "member",
    orgName: orgId,
    orgId,
  });

  it("adopts the only team in the signed-in account's org", () => {
    expect(
      resolveBootstrapDecision({
        teams: [inOrg("a", "gym"), inOrg("b", "betly"), inOrg("c", "betly")],
        homeOrgId: "gym",
      }),
    ).toEqual({ kind: "adopt", teamId: "a" });
  });

  it("asks only among the home org's teams", () => {
    const decision = resolveBootstrapDecision({
      teams: [inOrg("a", "gym"), inOrg("b", "betly"), inOrg("c", "gym")],
      homeOrgId: "gym",
    });
    expect(decision.kind === "selectTeam" && decision.teams.map((t) => t.id)).toEqual(["a", "c"]);
  });

  it("falls back to every team when the home org holds none", () => {
    const decision = resolveBootstrapDecision({
      teams: [inOrg("a", "x"), inOrg("b", "y")],
      homeOrgId: "gym",
    });
    expect(decision.kind).toBe("selectTeam");
  });

  it("does not narrow a remembered team from another org", () => {
    expect(
      resolveBootstrapDecision({
        teams: [inOrg("a", "gym"), inOrg("b", "betly")],
        homeOrgId: "gym",
        rememberedTeamId: "b",
      }),
    ).toEqual({ kind: "adopt", teamId: "b" });
  });

  it("scopeToHomeOrg keeps everything without a home org", () => {
    const items = [inOrg("a", "x")];
    expect(scopeToHomeOrg(items, null)).toEqual(items);
    expect(scopeToHomeOrg(items, "  ")).toEqual(items);
  });
});

describe("resolveBootstrapLanding (onboarding intent, #1589)", () => {
  it("lands a joiner with no team on the no-team screen, not create", () => {
    expect(resolveBootstrapLanding({ hasTeam: false, teamChoiceCount: 0, intent: "join" })).toBe(
      "noTeam",
    );
  });

  it("keeps the create path for create and for no recorded intent", () => {
    for (const intent of ["create", null, undefined] as const) {
      expect(resolveBootstrapLanding({ hasTeam: false, teamChoiceCount: 0, intent })).toBe(
        "createTeam",
      );
    }
  });

  it("ignores the intent once there is a team or a choice to make", () => {
    expect(resolveBootstrapLanding({ hasTeam: true, teamChoiceCount: 0, intent: "join" })).toBe(
      "ready",
    );
    expect(resolveBootstrapLanding({ hasTeam: false, teamChoiceCount: 2, intent: "join" })).toBe(
      "selectTeam",
    );
  });
});

function team(id: string, orgName: string | null = null): BootstrapTeam {
  return { id, name: id, slug: id, role: "member", orgName };
}

describe("resolveBootstrapDecision", () => {
  it("sends a user with no teams to create one", () => {
    expect(resolveBootstrapDecision({ teams: [] })).toEqual({ kind: "createTeam" });
  });

  it("adopts the only team without asking", () => {
    expect(resolveBootstrapDecision({ teams: [team("a")] })).toEqual({
      kind: "adopt",
      teamId: "a",
    });
  });

  it("asks when there is more than one and nothing remembered", () => {
    // This is the case Expo used to answer on the user's behalf, by taking
    // whichever team the listing returned first.
    const decision = resolveBootstrapDecision({ teams: [team("a"), team("b")] });
    expect(decision.kind).toBe("selectTeam");
    expect(decision.kind === "selectTeam" && decision.teams.map((t) => t.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("honours a remembered choice over asking again", () => {
    expect(
      resolveBootstrapDecision({
        teams: [team("a"), team("b")],
        rememberedTeamId: "b",
      }),
    ).toEqual({ kind: "adopt", teamId: "b" });
  });

  it("ignores a remembered team the user is no longer on", () => {
    // Losing access should land on the picker, not activate a team that will
    // fail — or strand the app with no way to choose another.
    const decision = resolveBootstrapDecision({
      teams: [team("a"), team("b")],
      rememberedTeamId: "gone",
    });
    expect(decision.kind).toBe("selectTeam");
  });

  it("still adopts the single team when the remembered one is stale", () => {
    expect(
      resolveBootstrapDecision({ teams: [team("a")], rememberedTeamId: "gone" }),
    ).toEqual({ kind: "adopt", teamId: "a" });
  });

  it("treats blank and whitespace remembered ids as absent", () => {
    for (const remembered of ["", "   ", null, undefined]) {
      expect(
        resolveBootstrapDecision({ teams: [team("a"), team("b")], rememberedTeamId: remembered }).kind,
      ).toBe("selectTeam");
    }
  });

  it("copies the team list rather than handing back the caller's array", () => {
    const teams = [team("a"), team("b")];
    const decision = resolveBootstrapDecision({ teams });
    if (decision.kind !== "selectTeam") throw new Error("expected selectTeam");
    expect(decision.teams).not.toBe(teams);
    expect(decision.teams).toEqual(teams);
  });
});
