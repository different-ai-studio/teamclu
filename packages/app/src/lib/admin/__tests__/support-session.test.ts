import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  startSupportSession: vi.fn(),
  endCurrentSupportSession: vi.fn(),
  adoptSession: vi.fn(),
  getSession: vi.fn(),
  writeCachedCurrentTeam: vi.fn(),
  signOut: vi.fn(),
  auth: { session: null as null | { user: { id: string } } },
  team: { id: "own-team", name: "Ops", slug: "ops" } as null | { id: string; name: string; slug: string },
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    admin: {
      startSupportSession: h.startSupportSession,
      endCurrentSupportSession: h.endCurrentSupportSession,
    },
    auth: { adoptSession: h.adoptSession },
  }),
}));

vi.mock("@/lib/auth/session-store", () => ({ getSession: h.getSession }));

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: { getState: () => ({ session: h.auth.session, signOut: h.signOut }) },
}));

vi.mock("@/stores/current-team", () => ({
  useCurrentTeamStore: { getState: () => ({ team: h.team }) },
  writeCachedCurrentTeam: h.writeCachedCurrentTeam,
}));

import {
  enterSupportSession,
  exitSupportSession,
  isInSupportSession,
  resetSupportSessionForTests,
  useSupportSessionStore,
} from "../support-session";

const OPERATOR = "op-user";
const SUPPORT = "support-user";
const TARGET = { id: "cust-team", name: "Customer", slug: "customer" };
const grant = {
  grantId: "g1",
  refreshToken: "support-rt",
  orgId: "cust-org",
  teamId: TARGET.id,
  actorId: "a1",
  supportUserId: SUPPORT,
  expiresAt: "2026-11-08T12:00:00Z",
};

function signInAs(id: string | null) {
  h.auth.session = id ? { user: { id } } : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSupportSessionForTests();
  signInAs(OPERATOR);
  h.getSession.mockReturnValue({ refresh_token: "operator-rt" });
  h.startSupportSession.mockResolvedValue(grant);
  h.adoptSession.mockImplementation(async (rt: string) => {
    signInAs(rt === "support-rt" ? SUPPORT : OPERATOR);
    return h.auth.session;
  });
  h.endCurrentSupportSession.mockResolvedValue({ ended: true });
});

describe("support session", () => {
  it("enters: keeps the operator's token, points the next login at the team, adopts the support session", async () => {
    await enterSupportSession({ orgId: "cust-org", orgName: "Customer Inc", team: TARGET, reason: "ticket 1" });

    expect(h.startSupportSession).toHaveBeenCalledWith("cust-org", { teamId: TARGET.id, reason: "ticket 1" });
    expect(h.writeCachedCurrentTeam).toHaveBeenCalledWith({ team: TARGET, currentMember: null, teamUserId: SUPPORT });
    expect(h.adoptSession).toHaveBeenCalledWith("support-rt");
    const record = useSupportSessionStore.getState().record!;
    expect(record.operator).toEqual({ userId: OPERATOR, refreshToken: "operator-rt", team: h.team });
    expect(JSON.parse(localStorage.getItem("teamclu:support-session.v1")!).supportUserId).toBe(SUPPORT);
    expect(isInSupportSession()).toBe(true);
  });

  it("is support mode only while signed in as the support account", async () => {
    await enterSupportSession({ orgId: "cust-org", orgName: null, team: TARGET, reason: "x" });
    expect(isInSupportSession(SUPPORT)).toBe(true);
    expect(isInSupportSession(OPERATOR)).toBe(false);
    expect(isInSupportSession(null)).toBe(false);
  });

  it("forgets the record when the support session cannot be adopted", async () => {
    h.adoptSession.mockRejectedValueOnce(new Error("refresh failed"));
    await expect(
      enterSupportSession({ orgId: "cust-org", orgName: null, team: TARGET, reason: "x" }),
    ).rejects.toThrow("refresh failed");
    expect(useSupportSessionStore.getState().record).toBeNull();
    expect(useSupportSessionStore.getState().busy).toBe(false);
  });

  it("leaves: ends the server session, returns to the operator's team and token", async () => {
    await enterSupportSession({ orgId: "cust-org", orgName: null, team: TARGET, reason: "x" });
    h.writeCachedCurrentTeam.mockClear();

    await exitSupportSession();

    expect(h.endCurrentSupportSession).toHaveBeenCalledTimes(1);
    expect(h.writeCachedCurrentTeam).toHaveBeenCalledWith({ team: h.team, currentMember: null, teamUserId: OPERATOR });
    expect(h.adoptSession).toHaveBeenLastCalledWith("operator-rt");
    expect(useSupportSessionStore.getState().record).toBeNull();
    expect(localStorage.getItem("teamclu:support-session.v1")).toBeNull();
  });

  it("still restores the operator when the support session is already gone", async () => {
    await enterSupportSession({ orgId: "cust-org", orgName: null, team: TARGET, reason: "x" });
    signInAs(null); // expired while the app was closed

    await exitSupportSession();

    expect(h.endCurrentSupportSession).not.toHaveBeenCalled();
    expect(h.adoptSession).toHaveBeenLastCalledWith("operator-rt");
  });

  it("signs out when the operator's own token no longer works", async () => {
    await enterSupportSession({ orgId: "cust-org", orgName: null, team: TARGET, reason: "x" });
    h.adoptSession.mockRejectedValueOnce(new Error("invalid_grant"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await exitSupportSession();

    expect(h.signOut).toHaveBeenCalledWith("support_exit_restore_failed");
    expect(useSupportSessionStore.getState().record).toBeNull();
  });

  it("refuses to nest support sessions", async () => {
    await enterSupportSession({ orgId: "cust-org", orgName: null, team: TARGET, reason: "x" });
    await expect(
      enterSupportSession({ orgId: "other", orgName: null, team: TARGET, reason: "y" }),
    ).rejects.toThrow("already in support mode");
    expect(h.startSupportSession).toHaveBeenCalledTimes(1);
  });
});
