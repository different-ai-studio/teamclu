import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";

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

const authState: { session: { user: { id: string } } | null; loading: boolean } = {
  session: { user: { id: "anon-1" } },
  loading: false,
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

const {
  useCurrentTeamStore,
  readCachedCurrentTeam,
  writeCachedCurrentTeam,
  initialCurrentTeamState,
  resolveTeamFromActiveOrgList,
  setLocalCacheTeamGate,
} = await import("./current-team");

const invokeMock = vi.mocked(invoke);

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
  authState.loading = false;
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
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

const TEAM_B = { id: "team-2", name: "Quiet Falcon", slug: "quiet-falcon" };
const TEAM_C = { id: "team-3", name: "Calm Heron", slug: "calm-heron" };
const MEMBER_B = { ...ACTIVE_MEMBER, id: "member-2", displayName: "You-B" };
const MEMBER_C = { ...ACTIVE_MEMBER, id: "member-3", displayName: "You-C" };
const FRESH_A = { ...ACTIVE_MEMBER, displayName: "fresh-A" };
const STALE_A = { ...ACTIVE_MEMBER, displayName: "stale-A" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type PendingGate = { teamId: string | null; finish: () => void };

function trackGateInvokes() {
  const pending: PendingGate[] = [];
  const issued: Array<string | null> = [];
  const applied: Array<string | null> = [];
  invokeMock.mockImplementation((_cmd: unknown, args?: { teamId?: string | null }) => {
    const teamId = args?.teamId ?? null;
    issued.push(teamId);
    return new Promise<void>((resolve) => {
      pending.push({
        teamId,
        finish: () => {
          applied.push(teamId);
          resolve();
        },
      });
    });
  });
  return { pending, issued, applied };
}

/** Let already-queued microtasks run, including a cached dynamic import. */
async function flushMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function gateIdsFromInvoke(): Array<string | null> {
  return invokeMock.mock.calls.map((call) => {
    const args = call[1] as { teamId?: string | null } | undefined;
    return args?.teamId ?? null;
  });
}

function arrangeSwitch(team = TEAM_B) {
  teamsMock.activateTeam.mockImplementation(async (id: string) => ({
    actorId: null,
    teamId: id,
    refreshToken: `rt-${id}`,
  }));
  authMock.adoptSession.mockResolvedValue({ user: { id: authState.session?.user.id ?? "anon-1" } });
  teamsMock.getTeam.mockImplementation(async (id: string) => (id === team.id ? { ...team } : { ...ACTIVE_TEAM }));
  directoryMock.getCurrentTeamMember.mockImplementation(async (teamId: string) =>
    teamId === TEAM_B.id ? MEMBER_B : FRESH_A,
  );
}

/**
 * Complete in-flight gate commands oldest-last (the completion order that lets
 * a stale write land on top), and keep doing that until `done` settles.
 */
async function releaseGatesUntil(
  pending: PendingGate[],
  done: Promise<unknown>,
): Promise<void> {
  let settled = false;
  done.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const deadline = Date.now() + 8000;
  while (!settled || pending.length > 0) {
    if (Date.now() > deadline) {
      throw new Error(`timed out releasing gate invokes; pending=${pending.length} settled=${settled}`);
    }
    if (pending.length > 0) {
      const batch = pending.splice(0, pending.length);
      for (let i = batch.length - 1; i >= 0; i -= 1) batch[i].finish();
    }
    await flushMacrotask();
  }
}

describe("current-team stale load", () => {
  it("does not let an older local-cache gate invocation land after a newer one", async () => {
    const gates = trackGateInvokes();
    const first = setLocalCacheTeamGate(ACTIVE_TEAM.id);
    await vi.waitFor(() => expect(gates.issued).toEqual([ACTIVE_TEAM.id]));
    const second = setLocalCacheTeamGate(TEAM_B.id);
    // Long enough for a second invoke to be issued if the two calls overlap.
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      expect(gates.pending.map((call) => call.teamId)).toEqual([ACTIVE_TEAM.id]);
    } finally {
      await releaseGatesUntil(gates.pending, Promise.all([first, second]));
    }
    expect(gates.applied).toEqual([ACTIVE_TEAM.id, TEAM_B.id]);
  });

  it("still applies a later gate update when an earlier invoke fails", async () => {
    invokeMock.mockRejectedValueOnce(new Error("no tauri")).mockResolvedValueOnce(undefined);

    await expect(setLocalCacheTeamGate(ACTIVE_TEAM.id)).resolves.toBeUndefined();
    await setLocalCacheTeamGate(TEAM_B.id);

    expect(invokeMock).toHaveBeenNthCalledWith(2, "local_cache_set_current_team", { teamId: TEAM_B.id });
  });

  it("keeps the cold-start cache while auth is still restoring", async () => {
    authState.session = null;
    authState.loading = true;
    useCurrentTeamStore.setState({
      team: ACTIVE_TEAM,
      currentMember: ACTIVE_MEMBER,
      teamUserId: "anon-1",
    });

    await useCurrentTeamStore.getState().load();

    expect(useCurrentTeamStore.getState().team).toEqual(ACTIVE_TEAM);
    expect(useCurrentTeamStore.getState().currentMember).toEqual(ACTIVE_MEMBER);
    expect(useCurrentTeamStore.getState().loading).toBe(false);
    expect(teamsMock.listCurrentUserTeams).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("still clears the team when the session is actually gone", async () => {
    authState.session = null;
    useCurrentTeamStore.setState({
      team: ACTIVE_TEAM,
      currentMember: ACTIVE_MEMBER,
      teamUserId: "anon-1",
    });

    await useCurrentTeamStore.getState().load();

    expect(useCurrentTeamStore.getState().team).toBeNull();
    expect(useCurrentTeamStore.getState().currentMember).toBeNull();
    expect(useCurrentTeamStore.getState().teamUserId).toBeNull();
    expect(readCachedCurrentTeam()).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("local_cache_set_current_team", { teamId: null });
  });

  it("still revalidates a held team and points the cache gate at it", async () => {
    useCurrentTeamStore.setState({ team: ACTIVE_TEAM, teamUserId: "anon-1" });
    teamsMock.listCurrentUserTeams.mockResolvedValueOnce([ACTIVE_TEAM]);
    directoryMock.getCurrentTeamMember.mockResolvedValueOnce(ACTIVE_MEMBER);

    await useCurrentTeamStore.getState().load();

    expect(useCurrentTeamStore.getState().team).toEqual(ACTIVE_TEAM);
    expect(useCurrentTeamStore.getState().currentMember).toEqual(ACTIVE_MEMBER);
    expect(invokeMock).toHaveBeenCalledWith("local_cache_set_current_team", { teamId: ACTIVE_TEAM.id });
    expect(readCachedCurrentTeam()).toEqual({
      team: ACTIVE_TEAM,
      currentMember: ACTIVE_MEMBER,
      teamUserId: "anon-1",
    });
  });

  it("does not let a late member result restore the team that was switched away", async () => {
    const gates = trackGateInvokes();
    const staleMember = deferred<typeof STALE_A>();
    const adopted = deferred<{ user: { id: string } }>();
    useCurrentTeamStore.setState({
      team: ACTIVE_TEAM,
      currentMember: ACTIVE_MEMBER,
      teamUserId: "anon-1",
    });
    teamsMock.listCurrentUserTeams.mockResolvedValue([ACTIVE_TEAM, TEAM_B]);
    directoryMock.getCurrentTeamMember.mockImplementation((teamId: string) => {
      if (teamId === ACTIVE_TEAM.id) return staleMember.promise;
      return Promise.resolve(MEMBER_B);
    });
    teamsMock.activateTeam.mockResolvedValue({ actorId: null, teamId: TEAM_B.id, refreshToken: "rt-b" });
    authMock.adoptSession.mockImplementation(() => adopted.promise);
    teamsMock.getTeam.mockResolvedValue({ ...TEAM_B });

    const loadPromise = useCurrentTeamStore.getState().load();
    await vi.waitFor(() => expect(gates.issued).toEqual([ACTIVE_TEAM.id]));

    const switchPromise = useCurrentTeamStore.getState().switchToTeam(TEAM_B.id);
    await vi.waitFor(() => expect(authMock.adoptSession).toHaveBeenCalled());
    adopted.resolve({ user: { id: "anon-1" } });
    await flushMacrotask();
    const overlappedWhileAInFlight = gates.pending.some((call) => call.teamId === TEAM_B.id);

    await releaseGatesUntil(gates.pending, switchPromise);
    // The switch has already published B. Resolving the original member now is
    // the late write that used to put A back.
    staleMember.resolve(STALE_A);
    await loadPromise;

    expect(overlappedWhileAInFlight).toBe(false);
    expect(gates.applied.at(-1)).toBe(TEAM_B.id);
    expect(directoryMock.getCurrentTeamMember.mock.calls.map((call) => call[0])).toEqual([TEAM_B.id]);
    expect(useCurrentTeamStore.getState().team?.id).toBe(TEAM_B.id);
    expect(useCurrentTeamStore.getState().currentMember).toEqual(MEMBER_B);
    expect(readCachedCurrentTeam()).toMatchObject({
      team: { id: TEAM_B.id },
      currentMember: MEMBER_B,
      teamUserId: "anon-1",
    });
  });

  it("does not let a list that returns during a switch move the cache gate back", async () => {
    const list = deferred<Array<typeof ACTIVE_TEAM | typeof TEAM_B>>();
    const teamFetch = deferred<typeof TEAM_B>();
    useCurrentTeamStore.setState({
      team: ACTIVE_TEAM,
      currentMember: ACTIVE_MEMBER,
      teamUserId: "anon-1",
    });
    teamsMock.listCurrentUserTeams.mockImplementation(() => list.promise);
    arrangeSwitch();
    teamsMock.getTeam.mockImplementation(() => teamFetch.promise);

    const loadPromise = useCurrentTeamStore.getState().load();
    await vi.waitFor(() => expect(teamsMock.listCurrentUserTeams).toHaveBeenCalled());
    const switchPromise = useCurrentTeamStore.getState().switchToTeam(TEAM_B.id);
    await vi.waitFor(() => expect(teamsMock.getTeam).toHaveBeenCalled());

    try {
      list.resolve([ACTIVE_TEAM, TEAM_B]);
      await flushMacrotask();
      expect(gateIdsFromInvoke()).toEqual([TEAM_B.id]);
      expect(directoryMock.getCurrentTeamMember).not.toHaveBeenCalled();
      expect(useCurrentTeamStore.getState().team).toEqual(ACTIVE_TEAM);
      expect(useCurrentTeamStore.getState().error).toBeNull();
      expect(useCurrentTeamStore.getState().loading).toBe(true);
    } finally {
      teamFetch.resolve({ ...TEAM_B });
    }

    await switchPromise;
    await loadPromise;
    expect(useCurrentTeamStore.getState().team?.id).toBe(TEAM_B.id);
    expect(useCurrentTeamStore.getState().error).toBeNull();
    expect(gateIdsFromInvoke().filter((id) => id === ACTIVE_TEAM.id)).toEqual([]);
  });

  it("does not let a late team list retarget the gate or refetch the member", async () => {
    const list = deferred<Array<typeof ACTIVE_TEAM | typeof TEAM_B>>();
    useCurrentTeamStore.setState({
      team: ACTIVE_TEAM,
      currentMember: ACTIVE_MEMBER,
      teamUserId: "anon-1",
    });
    teamsMock.listCurrentUserTeams.mockImplementation(() => list.promise);
    arrangeSwitch();

    const loadPromise = useCurrentTeamStore.getState().load();
    await vi.waitFor(() => expect(teamsMock.listCurrentUserTeams).toHaveBeenCalled());
    await useCurrentTeamStore.getState().switchToTeam(TEAM_B.id);
    useCurrentTeamStore.setState({ loading: true, error: "in-progress" });
    const gatesAfterSwitch = gateIdsFromInvoke().length;
    const membersAfterSwitch = directoryMock.getCurrentTeamMember.mock.calls.length;

    list.resolve([ACTIVE_TEAM, TEAM_B]);
    await loadPromise;

    expect(gateIdsFromInvoke()).toHaveLength(gatesAfterSwitch);
    expect(directoryMock.getCurrentTeamMember.mock.calls).toHaveLength(membersAfterSwitch);
    expect(useCurrentTeamStore.getState().team?.id).toBe(TEAM_B.id);
    expect(useCurrentTeamStore.getState().currentMember).toEqual(MEMBER_B);
    expect(useCurrentTeamStore.getState().loading).toBe(true);
    expect(useCurrentTeamStore.getState().error).toBe("in-progress");
    expect(readCachedCurrentTeam()?.team.id).toBe(TEAM_B.id);
  });

  it("does not let a late empty-of-target list clear the loading flag of a newer operation", async () => {
    const list = deferred<Array<typeof ACTIVE_TEAM>>();
    useCurrentTeamStore.setState({
      team: ACTIVE_TEAM,
      currentMember: ACTIVE_MEMBER,
      teamUserId: "anon-1",
    });
    teamsMock.listCurrentUserTeams.mockImplementation(() => list.promise);
    arrangeSwitch();

    const loadPromise = useCurrentTeamStore.getState().load();
    await vi.waitFor(() => expect(teamsMock.listCurrentUserTeams).toHaveBeenCalled());
    await useCurrentTeamStore.getState().switchToTeam(TEAM_B.id);
    useCurrentTeamStore.setState({ loading: true, error: "in-progress" });
    const gatesAfterSwitch = gateIdsFromInvoke().length;

    list.resolve([ACTIVE_TEAM]);
    await loadPromise;

    expect(useCurrentTeamStore.getState().team?.id).toBe(TEAM_B.id);
    expect(useCurrentTeamStore.getState().loading).toBe(true);
    expect(useCurrentTeamStore.getState().error).toBe("in-progress");
    expect(gateIdsFromInvoke()).toHaveLength(gatesAfterSwitch);
    expect(readCachedCurrentTeam()?.team.id).toBe(TEAM_B.id);
  });

  it("does not let a late list failure overwrite the team a switch is entering", async () => {
    const list = deferred<never>();
    const teamFetch = deferred<typeof TEAM_B>();
    useCurrentTeamStore.setState({
      team: ACTIVE_TEAM,
      currentMember: ACTIVE_MEMBER,
      teamUserId: "anon-1",
    });
    teamsMock.listCurrentUserTeams.mockImplementation(() => list.promise);
    arrangeSwitch();
    teamsMock.getTeam.mockImplementation(() => teamFetch.promise);

    const loadPromise = useCurrentTeamStore.getState().load();
    await vi.waitFor(() => expect(teamsMock.listCurrentUserTeams).toHaveBeenCalled());
    const switchPromise = useCurrentTeamStore.getState().switchToTeam(TEAM_B.id);
    await vi.waitFor(() => expect(teamsMock.getTeam).toHaveBeenCalled());

    try {
      list.reject(new Error("stale list"));
      await flushMacrotask();
      expect(useCurrentTeamStore.getState().team).toEqual(ACTIVE_TEAM);
      expect(useCurrentTeamStore.getState().error).toBeNull();
      expect(useCurrentTeamStore.getState().loading).toBe(true);
    } finally {
      teamFetch.resolve({ ...TEAM_B });
    }

    await switchPromise;
    await loadPromise;
    expect(useCurrentTeamStore.getState().team?.id).toBe(TEAM_B.id);
    expect(useCurrentTeamStore.getState().currentMember).toEqual(MEMBER_B);
    expect(useCurrentTeamStore.getState().error).toBeNull();
    expect(useCurrentTeamStore.getState().loading).toBe(false);
  });

  it("does not let a late list failure mark the team that was already entered", async () => {
    const list = deferred<never>();
    useCurrentTeamStore.setState({
      team: ACTIVE_TEAM,
      currentMember: ACTIVE_MEMBER,
      teamUserId: "anon-1",
    });
    teamsMock.listCurrentUserTeams.mockImplementation(() => list.promise);
    arrangeSwitch();

    const loadPromise = useCurrentTeamStore.getState().load();
    await vi.waitFor(() => expect(teamsMock.listCurrentUserTeams).toHaveBeenCalled());
    await useCurrentTeamStore.getState().switchToTeam(TEAM_B.id);

    list.reject(new Error("stale list"));
    await loadPromise;

    expect(useCurrentTeamStore.getState().team?.id).toBe(TEAM_B.id);
    expect(useCurrentTeamStore.getState().currentMember).toEqual(MEMBER_B);
    expect(useCurrentTeamStore.getState().error).toBeNull();
    expect(useCurrentTeamStore.getState().loading).toBe(false);
    expect(readCachedCurrentTeam()?.team.id).toBe(TEAM_B.id);
  });

  it("does not let a late member result restore a team cleared by sign-out", async () => {
    const staleMember = deferred<typeof ACTIVE_MEMBER>();
    useCurrentTeamStore.setState({
      team: ACTIVE_TEAM,
      currentMember: ACTIVE_MEMBER,
      teamUserId: "anon-1",
    });
    teamsMock.listCurrentUserTeams.mockResolvedValue([ACTIVE_TEAM]);
    directoryMock.getCurrentTeamMember.mockImplementation(() => staleMember.promise);

    const loadPromise = useCurrentTeamStore.getState().load();
    await vi.waitFor(() => expect(directoryMock.getCurrentTeamMember).toHaveBeenCalled());

    // Matches auth-store.signOut: the session is cleared and the team object is
    // dropped, while teamUserId is left for the cache writer to ignore.
    authState.session = null;
    useCurrentTeamStore.setState({
      team: null,
      currentMember: null,
      loading: false,
      error: null,
    });
    expect(readCachedCurrentTeam()).toBeNull();

    staleMember.resolve(ACTIVE_MEMBER);
    await loadPromise;

    expect(useCurrentTeamStore.getState().team).toBeNull();
    expect(useCurrentTeamStore.getState().currentMember).toBeNull();
    expect(readCachedCurrentTeam()).toBeNull();
    expect(invokeMock.mock.calls.filter((call) => {
      const args = call[1] as { teamId?: string | null } | undefined;
      return args?.teamId === ACTIVE_TEAM.id;
    })).toHaveLength(1);
  });

  it("does not let a signed-out load clear a team entered while its gate reset is in flight", async () => {
    const gates = trackGateInvokes();
    authState.session = null;
    useCurrentTeamStore.setState({ team: null, currentMember: null, teamUserId: null });

    const loadPromise = useCurrentTeamStore.getState().load();
    await vi.waitFor(() => expect(gates.issued).toEqual([null]));

    authState.session = { user: { id: "anon-1" } };
    const adopted = deferred<{ user: { id: string } }>();
    teamsMock.activateTeam.mockResolvedValue({ actorId: null, teamId: TEAM_B.id, refreshToken: "rt-b" });
    authMock.adoptSession.mockImplementation(() => adopted.promise);
    teamsMock.getTeam.mockResolvedValue({ ...TEAM_B });
    directoryMock.getCurrentTeamMember.mockResolvedValue(MEMBER_B);

    const switchPromise = useCurrentTeamStore.getState().switchToTeam(TEAM_B.id);
    await vi.waitFor(() => expect(authMock.adoptSession).toHaveBeenCalled());
    adopted.resolve({ user: { id: "anon-1" } });
    await flushMacrotask();
    const overlapped = gates.pending.some((call) => call.teamId === TEAM_B.id);

    await releaseGatesUntil(gates.pending, Promise.all([switchPromise, loadPromise]));

    expect(overlapped).toBe(false);
    expect(gates.applied.at(-1)).toBe(TEAM_B.id);
    expect(useCurrentTeamStore.getState().team?.id).toBe(TEAM_B.id);
    expect(useCurrentTeamStore.getState().currentMember).toEqual(MEMBER_B);
    expect(readCachedCurrentTeam()).toMatchObject({
      team: { id: TEAM_B.id },
      currentMember: MEMBER_B,
      teamUserId: "anon-1",
    });
  });

  it("does not apply a late member result after the signed-in user changes", async () => {
    const staleMember = deferred<typeof STALE_A>();
    const held = { ...ACTIVE_TEAM };
    useCurrentTeamStore.setState({
      team: held,
      currentMember: ACTIVE_MEMBER,
      teamUserId: "anon-1",
    });
    teamsMock.listCurrentUserTeams.mockResolvedValue([held]);
    directoryMock.getCurrentTeamMember.mockImplementation(() => staleMember.promise);

    const loadPromise = useCurrentTeamStore.getState().load();
    await vi.waitFor(() => expect(directoryMock.getCurrentTeamMember).toHaveBeenCalled());
    authState.session = { user: { id: "anon-2" } };

    staleMember.resolve(STALE_A);
    await loadPromise;

    expect(useCurrentTeamStore.getState().team).toBe(held);
    expect(useCurrentTeamStore.getState().currentMember).toEqual(ACTIVE_MEMBER);
    expect(useCurrentTeamStore.getState().teamUserId).toBe("anon-1");
    expect(readCachedCurrentTeam()?.currentMember?.displayName).toBe(ACTIVE_MEMBER.displayName);
  });

  it("does not let a late member result overwrite the team installed for the new user", async () => {
    const staleMember = deferred<typeof STALE_A>();
    useCurrentTeamStore.setState({
      team: ACTIVE_TEAM,
      currentMember: ACTIVE_MEMBER,
      teamUserId: "anon-1",
    });
    teamsMock.listCurrentUserTeams.mockResolvedValue([ACTIVE_TEAM, TEAM_C]);
    directoryMock.getCurrentTeamMember.mockImplementation(() => staleMember.promise);

    const loadPromise = useCurrentTeamStore.getState().load();
    await vi.waitFor(() => expect(directoryMock.getCurrentTeamMember).toHaveBeenCalled());
    authState.session = { user: { id: "anon-2" } };
    useCurrentTeamStore.setState({
      team: TEAM_C,
      currentMember: MEMBER_C,
      teamUserId: "anon-2",
    });

    staleMember.resolve(STALE_A);
    await loadPromise;

    expect(useCurrentTeamStore.getState().team).toBe(TEAM_C);
    expect(useCurrentTeamStore.getState().currentMember).toEqual(MEMBER_C);
    expect(useCurrentTeamStore.getState().teamUserId).toBe("anon-2");
    expect(readCachedCurrentTeam()).toMatchObject({
      team: TEAM_C,
      currentMember: MEMBER_C,
      teamUserId: "anon-2",
    });
  });

  it("does not let the original load write team A after the user leaves and comes back", async () => {
    const staleMember = deferred<typeof STALE_A>();
    let memberReadsForA = 0;
    useCurrentTeamStore.setState({
      team: ACTIVE_TEAM,
      currentMember: ACTIVE_MEMBER,
      teamUserId: "anon-1",
    });
    teamsMock.listCurrentUserTeams.mockResolvedValue([ACTIVE_TEAM, TEAM_B]);
    arrangeSwitch();
    directoryMock.getCurrentTeamMember.mockImplementation((teamId: string) => {
      if (teamId === TEAM_B.id) return Promise.resolve(MEMBER_B);
      memberReadsForA += 1;
      if (memberReadsForA === 1) return staleMember.promise;
      return Promise.resolve(FRESH_A);
    });

    const loadPromise = useCurrentTeamStore.getState().load();
    await vi.waitFor(() => expect(memberReadsForA).toBe(1));
    await useCurrentTeamStore.getState().switchToTeam(TEAM_B.id);
    await useCurrentTeamStore.getState().switchToTeam(ACTIVE_TEAM.id);
    const returned = useCurrentTeamStore.getState().team;
    const returnedMember = useCurrentTeamStore.getState().currentMember;

    staleMember.resolve(STALE_A);
    await loadPromise;

    expect(returned?.id).toBe(ACTIVE_TEAM.id);
    expect(returnedMember).toEqual(FRESH_A);
    expect(useCurrentTeamStore.getState().team).toBe(returned);
    expect(useCurrentTeamStore.getState().currentMember).toEqual(FRESH_A);
    expect(readCachedCurrentTeam()?.currentMember?.displayName).toBe("fresh-A");
  });
});
