import { describe, it, expect, vi, beforeEach } from "vitest";

const teamsMock = {
  listCurrentUserTeams: vi.fn(),
  getTeam: vi.fn(),
  renameTeam: vi.fn(),
  activateTeam: vi.fn(),
};
const directoryMock = {
  getCurrentTeamMember: vi.fn(),
};
const authMock = {
  adoptSession: vi.fn(),
};
const backendMock = {
  teams: teamsMock,
  directory: directoryMock,
  auth: authMock,
};

const authState: { session: { user: { id: string } } | null } = {
  session: { user: { id: "anon-1" } },
};

vi.mock("@/lib/backend", () => ({
  getBackend: () => backendMock,
}));

vi.mock("./auth-store", () => ({
  useAuthStore: {
    getState: () => authState,
  },
}));

// current-team dynamically imports the Tauri core to set the local-cache gate;
// stub it so the store runs in the jsdom test environment.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

const { useCurrentTeamStore, readCachedCurrentTeam, writeCachedCurrentTeam, initialCurrentTeamState, resolveTeamFromActiveOrgList } =
  await import("./current-team");

const ACTIVE_TEAM = { id: "team-1", name: "Brave Otter", slug: "brave-otter" };
const ACTIVE_MEMBER = {
  id: "member-1",
  displayName: "You",
  roles: [{ id: "role-owner", code: "owner", name: "Owner" }],
  role: "owner",
  joinedAt: "2026-05-29T00:00:00.000Z",
};

beforeEach(() => {
  teamsMock.listCurrentUserTeams.mockReset();
  teamsMock.getTeam.mockReset();
  teamsMock.activateTeam.mockReset();
  authMock.adoptSession.mockReset();
  directoryMock.getCurrentTeamMember.mockReset();
  authState.session = { user: { id: "anon-1" } };
  localStorage.clear();
  useCurrentTeamStore.setState({
    team: null,
    currentMember: null,
    teamUserId: null,
    loading: false,
    saving: false,
    error: null,
  });
});

describe("current-team persistence cache", () => {
  it("persists the resolved team when load revalidates a held team", async () => {
    useCurrentTeamStore.setState({ team: ACTIVE_TEAM, teamUserId: "anon-1" });
    teamsMock.listCurrentUserTeams.mockResolvedValueOnce([ACTIVE_TEAM]);
    directoryMock.getCurrentTeamMember.mockResolvedValueOnce(ACTIVE_MEMBER);

    await useCurrentTeamStore.getState().load();

    expect(readCachedCurrentTeam()).toEqual({
      team: ACTIVE_TEAM,
      currentMember: ACTIVE_MEMBER,
      teamUserId: "anon-1",
    });
  });

  it("clears the persisted team when the session resolves team-less", async () => {
    writeCachedCurrentTeam({ team: ACTIVE_TEAM, currentMember: ACTIVE_MEMBER, teamUserId: "anon-1" });
    teamsMock.listCurrentUserTeams.mockResolvedValueOnce([]);

    await useCurrentTeamStore.getState().load();

    expect(readCachedCurrentTeam()).toBeNull();
  });

  it("hydrates initial store state from a persisted cache", () => {
    writeCachedCurrentTeam({ team: ACTIVE_TEAM, currentMember: ACTIVE_MEMBER, teamUserId: "anon-1" });

    expect(initialCurrentTeamState()).toEqual({
      team: ACTIVE_TEAM,
      currentMember: ACTIVE_MEMBER,
      teamUserId: "anon-1",
    });
  });

  it("ignores a malformed cache entry", () => {
    localStorage.setItem("teamclu:current-team", "not json{");
    expect(readCachedCurrentTeam()).toBeNull();
    expect(initialCurrentTeamState()).toEqual({ team: null, currentMember: null, teamUserId: null });
  });
});

describe("useCurrentTeamStore.load", () => {
  it("does not clobber an already-active team when the list comes back empty (RLS replica lag)", async () => {
    // AuthGate already populated the store with the freshly auto-created team
    // for THIS user (teamUserId matches the session).
    useCurrentTeamStore.setState({
      team: ACTIVE_TEAM,
      currentMember: ACTIVE_MEMBER,
      teamUserId: "anon-1",
    });
    // The follow-up list query can't see the just-written membership yet.
    teamsMock.listCurrentUserTeams.mockResolvedValueOnce([]);

    await useCurrentTeamStore.getState().load();

    const state = useCurrentTeamStore.getState();
    expect(state.team).toEqual(ACTIVE_TEAM);
    expect(state.currentMember).toEqual(ACTIVE_MEMBER);
    expect(state.loading).toBe(false);
    // We bailed before re-fetching the member.
    expect(directoryMock.getCurrentTeamMember).not.toHaveBeenCalled();
  });

  it("does NOT preserve a team belonging to a different user (logout + re-login)", async () => {
    // Previous user's team still in the store, new session is a different user.
    useCurrentTeamStore.setState({
      team: ACTIVE_TEAM,
      currentMember: ACTIVE_MEMBER,
      teamUserId: "prev-user",
    });
    authState.session = { user: { id: "anon-1" } };
    teamsMock.listCurrentUserTeams.mockResolvedValueOnce([]);

    await useCurrentTeamStore.getState().load();

    // The foreign team must be cleared, not carried into the new user's session.
    const state = useCurrentTeamStore.getState();
    expect(state.team).toBeNull();
    expect(state.currentMember).toBeNull();
  });

  it("clears the team for a genuinely team-less session (empty list, no prior team)", async () => {
    teamsMock.listCurrentUserTeams.mockResolvedValueOnce([]);

    await useCurrentTeamStore.getState().load();

    const state = useCurrentTeamStore.getState();
    expect(state.team).toBeNull();
    expect(state.currentMember).toBeNull();
    expect(state.loading).toBe(false);
  });

  it("does not auto-select a team when held is empty and rows are non-empty", async () => {
    teamsMock.listCurrentUserTeams.mockResolvedValueOnce([ACTIVE_TEAM]);

    await useCurrentTeamStore.getState().load();

    const state = useCurrentTeamStore.getState();
    expect(state.team).toBeNull();
    expect(state.currentMember).toBeNull();
    expect(state.loading).toBe(false);
    expect(directoryMock.getCurrentTeamMember).not.toHaveBeenCalled();
  });
});

describe("load() team selection", () => {
  const OTHER_TEAM = { id: "team-2", name: "Quiet Falcon", slug: "quiet-falcon" };

  it("keeps the team the user is already on when it is still in the active org", async () => {
    // Ordered so the held team is NOT first — the old `limit: 1` code took
    // rows[0] and silently relocated multi-team users on every mount.
    teamsMock.listCurrentUserTeams.mockResolvedValueOnce([OTHER_TEAM, ACTIVE_TEAM]);
    directoryMock.getCurrentTeamMember.mockResolvedValueOnce(ACTIVE_MEMBER);
    useCurrentTeamStore.setState({ team: ACTIVE_TEAM, teamUserId: "anon-1" });

    await useCurrentTeamStore.getState().load();

    expect(useCurrentTeamStore.getState().team).toEqual(ACTIVE_TEAM);
  });

  it("preserves the held team when it is not in the active org list", async () => {
    teamsMock.listCurrentUserTeams.mockResolvedValueOnce([OTHER_TEAM]);
    useCurrentTeamStore.setState({ team: ACTIVE_TEAM, teamUserId: "anon-1" });

    await useCurrentTeamStore.getState().load();

    expect(useCurrentTeamStore.getState().team).toEqual(ACTIVE_TEAM);
    expect(directoryMock.getCurrentTeamMember).not.toHaveBeenCalled();
  });
});

describe("resolveTeamFromActiveOrgList", () => {
  const OTHER_TEAM = { id: "team-2", name: "Quiet Falcon", slug: "quiet-falcon" };

  it("revalidates when the held team is still listed", () => {
    expect(
      resolveTeamFromActiveOrgList([OTHER_TEAM, ACTIVE_TEAM], ACTIVE_TEAM, "anon-1", "anon-1"),
    ).toEqual({ action: "revalidate", row: ACTIVE_TEAM });
  });

  it("preserves when the held team left the active org for the same user", () => {
    expect(
      resolveTeamFromActiveOrgList([OTHER_TEAM], ACTIVE_TEAM, "anon-1", "anon-1"),
    ).toEqual({ action: "preserve" });
  });

  it("does not auto-select when held is empty", () => {
    expect(resolveTeamFromActiveOrgList([ACTIVE_TEAM], null, "anon-1", null)).toEqual({
      action: "no_selection",
    });
  });
});

describe("enterTeam", () => {
  it("activates and adopts the minted session before setting the team", async () => {
    const calls: string[] = [];
    teamsMock.activateTeam = vi.fn(async () => {
      calls.push("activate");
      return { actorId: null, teamId: "team-2", refreshToken: "rt-2" };
    });
    authMock.adoptSession = vi.fn(async () => {
      calls.push("adopt");
      return null;
    });
    teamsMock.getTeam.mockImplementation(async () => {
      calls.push("getTeam");
      return { id: "team-2", name: "Quiet Falcon", slug: "quiet-falcon" };
    });
    directoryMock.getCurrentTeamMember.mockResolvedValueOnce(ACTIVE_MEMBER);

    await useCurrentTeamStore.getState().enterTeam("team-2");

    // Order matters: getTeam before adopt would read with the stale org.
    expect(calls).toEqual(["activate", "adopt", "getTeam"]);
    expect(useCurrentTeamStore.getState().team?.id).toBe("team-2");
  });

  it("resolves the member with the identity returned by the activated session", async () => {
    teamsMock.activateTeam.mockResolvedValueOnce({ actorId: null, teamId: "team-2", refreshToken: "rt-2" });
    authMock.adoptSession.mockResolvedValueOnce({ user: { id: "linked-user" } });
    teamsMock.getTeam.mockResolvedValueOnce({ id: "team-2", name: "Quiet Falcon", slug: "quiet-falcon" });
    directoryMock.getCurrentTeamMember.mockResolvedValueOnce(ACTIVE_MEMBER);

    await useCurrentTeamStore.getState().enterTeam("team-2");

    expect(directoryMock.getCurrentTeamMember).toHaveBeenCalledWith("team-2", "linked-user");
    expect(useCurrentTeamStore.getState().teamUserId).toBe("linked-user");
  });

  it("skips activation when the caller knows the team is already in the active org", async () => {
    teamsMock.activateTeam = vi.fn();
    teamsMock.getTeam.mockResolvedValueOnce(ACTIVE_TEAM);
    directoryMock.getCurrentTeamMember.mockResolvedValueOnce(ACTIVE_MEMBER);

    await useCurrentTeamStore.getState().enterTeam("team-1", { assumeActive: true });

    expect(teamsMock.activateTeam).not.toHaveBeenCalled();
    expect(useCurrentTeamStore.getState().team?.id).toBe("team-1");
  });
});
