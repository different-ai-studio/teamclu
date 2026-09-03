import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudApiError } from "@/lib/backend/cloud-api/http";

/** What the server sends when self-registration is off and the caller has no org. */
function registrationDisabled() {
  return new CloudApiError(403, "registration_disabled", "self-registration is disabled");
}

const { setLocalCacheTeamGateMock, removeStartupSkeletonMock, isTauriMock, extensionPolicyMock } = vi.hoisted(() => ({
  setLocalCacheTeamGateMock: vi.fn().mockResolvedValue(undefined),
  removeStartupSkeletonMock: vi.fn(),
  isTauriMock: vi.fn(() => true),
  extensionPolicyMock: {
    isExtension: false,
    autoCreateTeam: true,
    noTeamMessage: { 'zh-CN': '请联系管理员邀请你加入团队。' } as Record<string, string>,
  },
}));

/**
 * The persisted current-team snapshot (localStorage) the gate reads to decide
 * what to restore. Mutable so a test can present a returning user.
 */
const { cachedTeamMock } = vi.hoisted(() => ({
  cachedTeamMock: {
    value: null as null | { team: { id: string } | null; teamUserId: string | null },
  },
}));

const { authState, currentTeamMock, backendMock } = vi.hoisted(() => ({
  authState: {
    session: { user: { id: "user-1" } } as { user: { id: string; isAnonymous?: boolean } } | null,
    loading: false,
    authFlow: "idle" as "idle" | "invite",
    hydrate: vi.fn(),
    pendingInviteToken: null as string | null,
    claimPendingInvite: vi.fn(),
    // Contact-matched invites (PendingInvitesDialog). Empty by default so the
    // dialog stays closed and these tests only exercise the gate itself.
    pendingInvites: [] as unknown[],
    refreshPendingInvites: vi.fn(),
    acceptPendingInvite: vi.fn(),
    declinePendingInvite: vi.fn(),
    signOut: vi.fn(),
  },
  currentTeamMock: {
    reloadAndSwitchTo: vi.fn(),
    setActiveTeam: vi.fn(),
    switchToTeam: vi.fn(),
    team: null as null | { id: string },
    teamUserId: null as null | string,
  },
  backendMock: {
    teams: {
      listCurrentUserTeams: vi.fn(),
      listAllMyTeams: vi.fn(),
      createTeam: vi.fn(),
      bootstrapTeam: vi.fn(),
    },
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock("@/stores/auth-store", () => {
  const useAuthStore = (selector?: (s: typeof authState) => unknown) =>
    selector ? selector(authState) : authState;
  useAuthStore.getState = () => authState;
  return { useAuthStore };
});

vi.mock("@/stores/current-team", () => ({
  useCurrentTeamStore: {
    getState: () => currentTeamMock,
  },
  setLocalCacheTeamGate: setLocalCacheTeamGateMock,
  readCachedCurrentTeam: () => cachedTeamMock.value,
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => backendMock,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(" "),
  isTauri: () => isTauriMock(),
  removeStartupSkeleton: () => removeStartupSkeletonMock(),
}));

vi.mock("@/lib/platform", () => ({
  isChromeExtension: () => extensionPolicyMock.isExtension,
}));

vi.mock("@/lib/build-config", () => ({
  extensionTeamOnboarding: extensionPolicyMock,
}));

vi.mock("@/stores/setup", () => ({
  useSetupStore: (selector: (s: { loaded: boolean; requiredSatisfied: () => boolean; listRequirements: () => void }) => unknown) =>
    selector({ loaded: true, requiredSatisfied: () => true, listRequirements: () => {} }),
  setupPreviouslySatisfied: () => false,
}));

// These cases exercise everything *after* first-run onboarding, so present a
// machine that has already been through it. The onboarding gate itself is
// covered in AuthGateOnboarding.test.tsx.
const onboardingState = {
  role: "developer" as const,
  runtime: "opencode" as const,
  completed: true,
  setRole: vi.fn(),
  markCompleted: vi.fn(),
};
vi.mock("@/stores/onboarding", () => ({
  useOnboardingStore: Object.assign(
    (selector: (s: typeof onboardingState) => unknown) => selector(onboardingState),
    { getState: () => onboardingState },
  ),
}));

vi.mock("@/components/onboarding/RoleStep", () => ({ RoleStep: () => <div>role step</div> }));
vi.mock("@/components/onboarding/SetupStep", () => ({ SetupStep: () => <div>setup step</div> }));

vi.mock("@/stores/daemon-onboarding", () => ({
  useDaemonOnboardingStore: (
    selector: (s: {
      status: string
      loaded: boolean
      refresh: () => Promise<void>
      pendingName: null
    }) => unknown,
  ) =>
    // pendingName is explicit: a machine already bound has no naming prompt, and
    // the gate holds while one is pending.
    selector({ status: 'ready', loaded: true, refresh: async () => {}, pendingName: null }),
}));

vi.mock("../DaemonOnboardingWizard", () => ({
  DaemonOnboardingWizard: ({ onDone }: { onDone: () => void }) => (
    <button onClick={onDone}>Daemon onboarding wizard</button>
  ),
}));

vi.mock("../DesktopOnboarding", () => ({
  DesktopOnboarding: () => <div>Desktop onboarding</div>,
}));

vi.mock("../LoginScreen", () => ({
  LoginScreen: () => <div>Login screen</div>,
}));

vi.mock("../TeamPicker", () => ({
  TeamPicker: ({ teams }: { teams: Array<{ name: string }> }) => <div>Team picker: {teams.map((team) => team.name).join(", ")}</div>,
}));

import { AuthGate } from "../AuthGate";
import {
  resetInviteLinkConfirmationForTests,
  useInviteLinkConfirmation,
} from "@/lib/invite-link-confirmation";

beforeEach(() => {
  resetInviteLinkConfirmationForTests();
  authState.session = { user: { id: "user-1" } };
  authState.loading = false;
  authState.authFlow = "idle";
  authState.hydrate.mockReset();
  authState.pendingInviteToken = null;
  authState.pendingInvites = [];
  authState.refreshPendingInvites.mockReset();
  authState.refreshPendingInvites.mockResolvedValue(undefined);
  authState.acceptPendingInvite.mockReset();
  authState.declinePendingInvite.mockReset();
  authState.signOut.mockReset();
  backendMock.teams.listCurrentUserTeams.mockReset();
  backendMock.teams.listAllMyTeams.mockReset();
  backendMock.teams.createTeam.mockReset();
  backendMock.teams.bootstrapTeam.mockReset();
  currentTeamMock.reloadAndSwitchTo.mockReset();
  currentTeamMock.setActiveTeam.mockReset();
  currentTeamMock.switchToTeam.mockReset();
  currentTeamMock.team = null;
  currentTeamMock.teamUserId = null;
  cachedTeamMock.value = null;
  backendMock.teams.listAllMyTeams.mockResolvedValue([]);
  backendMock.teams.bootstrapTeam.mockResolvedValue({ id: "team-bootstrap", name: "Bootstrap", slug: "bootstrap" });
  setLocalCacheTeamGateMock.mockClear();
  removeStartupSkeletonMock.mockClear();
  isTauriMock.mockReturnValue(true);
  extensionPolicyMock.isExtension = false;
  extensionPolicyMock.autoCreateTeam = true;
});

describe("AuthGate", () => {
  it("keeps the shell blocked while an authenticated onboarding operation is loading", async () => {
    authState.loading = true;

    const { container } = render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    // Loading gates now render nothing (the static #skeleton shows through #root
    // in the real app) instead of a Lobster spinner — the shell stays blocked.
    await waitFor(() => expect(screen.queryByText("App shell")).not.toBeInTheDocument());
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps desktop onboarding mounted while an unauthenticated action is loading", async () => {
    authState.session = null;
    authState.loading = false;

    const view = render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() => expect(screen.getByText("Desktop onboarding")).toBeInTheDocument());

    authState.loading = true;
    view.rerender(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    expect(screen.getByText("Desktop onboarding")).toBeInTheDocument();
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    expect(screen.queryByText("App shell")).not.toBeInTheDocument();
  });

  it("keeps desktop onboarding mounted while an invite claim has an anonymous session", async () => {
    authState.session = { user: { id: "anon-invite" } };
    authState.loading = true;
    authState.authFlow = "invite";

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() => expect(screen.getByText("Desktop onboarding")).toBeInTheDocument());
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    expect(screen.queryByText("App shell")).not.toBeInTheDocument();
  });



  it("restores and activates a same-user cached team", async () => {
    // current-team was hydrated from the persisted cache for THIS user.
    currentTeamMock.team = { id: "team-cached" };
    currentTeamMock.teamUserId = "user-1";
    backendMock.teams.listAllMyTeams.mockResolvedValueOnce([
      { id: "team-cached", name: "Cached", slug: "cached", orgId: "org-1", orgName: "Org" },
    ]);

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() => expect(currentTeamMock.switchToTeam).toHaveBeenCalledWith("team-cached"));
    await waitFor(() => expect(screen.getByText("App shell")).toBeInTheDocument());
  });

  /*
   * The remembered team must outrank the picker. Before this, the picker's gate
   * (2+ memberships, or any joinable public team) was checked FIRST, so a
   * returning user with several teams re-picked on every single launch and the
   * remembered id only decorated a row with a "Last used" badge.
   */
  it("restores the remembered team instead of asking again when the user has several", async () => {
    cachedTeamMock.value = { team: { id: "team-b" }, teamUserId: "user-1" };
    backendMock.teams.listAllMyTeams.mockResolvedValue([
      { id: "team-a", name: "Alpha", slug: "alpha", orgId: "org-1", orgName: "Org" },
      { id: "team-b", name: "Beta", slug: "beta", orgId: "org-1", orgName: "Org" },
      { id: "team-c", name: "Gamma", slug: "gamma", orgId: "org-2", orgName: "Other" },
    ]);

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() => expect(currentTeamMock.switchToTeam).toHaveBeenCalledWith("team-b"));
    await waitFor(() => expect(screen.getByText("App shell")).toBeInTheDocument());
    expect(screen.queryByText(/Team picker/)).not.toBeInTheDocument();
  });

  // Every org gets an org-named PUBLIC default team, so a single-membership user
  // normally has a joinable row in the listing too — which used to be enough to
  // force the picker on every launch.
  it("restores the remembered team even when a joinable public team is listed", async () => {
    cachedTeamMock.value = { team: { id: "team-mine" }, teamUserId: "user-1" };
    backendMock.teams.listAllMyTeams.mockResolvedValue([
      { id: "team-mine", name: "Mine", slug: "mine", orgId: "org-1", orgName: "Org" },
      { id: "team-open", name: "Org", slug: "org", orgId: "org-1", orgName: "Org", isMember: false },
    ]);

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() => expect(currentTeamMock.switchToTeam).toHaveBeenCalledWith("team-mine"));
    await waitFor(() => expect(screen.getByText("App shell")).toBeInTheDocument());
    expect(screen.queryByText(/Team picker/)).not.toBeInTheDocument();
  });

  it("falls back to the picker when the remembered team is no longer a membership", async () => {
    cachedTeamMock.value = { team: { id: "team-gone" }, teamUserId: "user-1" };
    backendMock.teams.listAllMyTeams.mockResolvedValue([
      { id: "team-a", name: "Alpha", slug: "alpha", orgId: "org-1", orgName: "Org" },
      { id: "team-b", name: "Beta", slug: "beta", orgId: "org-1", orgName: "Org" },
    ]);

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() => expect(screen.getByText(/Team picker/)).toBeInTheDocument());
    expect(currentTeamMock.switchToTeam).not.toHaveBeenCalled();
  });

  it("ignores a remembered team that belongs to a different user", async () => {
    cachedTeamMock.value = { team: { id: "team-foreign" }, teamUserId: "other-user" };
    backendMock.teams.listAllMyTeams.mockResolvedValue([
      { id: "team-a", name: "Alpha", slug: "alpha", orgId: "org-1", orgName: "Org" },
      { id: "team-foreign", name: "Foreign", slug: "foreign", orgId: "org-9", orgName: "Theirs" },
    ]);

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() => expect(screen.getByText(/Team picker/)).toBeInTheDocument());
    expect(currentTeamMock.switchToTeam).not.toHaveBeenCalled();
  });

  it("does not adopt a cached team that belongs to a different user", async () => {
    // A previous user's team is still in the store (persisted cache), but the
    // session is a different user — must re-resolve, not reuse the foreign team.
    currentTeamMock.team = { id: "team-foreign" };
    currentTeamMock.teamUserId = "other-user";
    backendMock.teams.listAllMyTeams.mockResolvedValueOnce([
      { id: "team-mine", name: "Mine", slug: "mine", orgId: "org-1", orgName: "Org" },
    ]);
    currentTeamMock.setActiveTeam.mockResolvedValueOnce(undefined);

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() => expect(currentTeamMock.switchToTeam).toHaveBeenCalledWith("team-mine"));
    await waitFor(() => expect(screen.getByText("App shell")).toBeInTheDocument());
  });

  it("activates a sole existing team without showing the chooser", async () => {
    backendMock.teams.listAllMyTeams.mockResolvedValueOnce([
      { id: "team-existing", name: "Acme", slug: "acme", orgId: "org-1", orgName: "Org" },
    ]);
    currentTeamMock.setActiveTeam.mockResolvedValueOnce(undefined);

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() => expect(currentTeamMock.switchToTeam).toHaveBeenCalledWith("team-existing"));
    await waitFor(() => expect(screen.getByText("App shell")).toBeInTheDocument());
  });

  it("activates a sole membership before entering the desktop shell", async () => {
    backendMock.teams.listCurrentUserTeams.mockResolvedValueOnce([
      { id: "team-existing", name: "Acme", slug: "acme" },
    ]);
    backendMock.teams.listAllMyTeams.mockResolvedValueOnce([
      { id: "team-existing", name: "Acme", slug: "acme", isMember: true },
    ]);
    currentTeamMock.setActiveTeam.mockResolvedValueOnce(undefined);
    currentTeamMock.switchToTeam.mockResolvedValueOnce(undefined);

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() => expect(currentTeamMock.switchToTeam).toHaveBeenCalledWith("team-existing"));
    await waitFor(() => expect(screen.getByText("App shell")).toBeInTheDocument());
  });

  it("bootstraps a first org team and switches to it before rendering the shell", async () => {
    backendMock.teams.listCurrentUserTeams.mockResolvedValueOnce([]);
    backendMock.teams.listAllMyTeams.mockResolvedValueOnce([]);
    backendMock.teams.bootstrapTeam.mockResolvedValueOnce({
      id: "team-new",
      name: "Trial Team",
      slug: "trial-team",
    });
    currentTeamMock.setActiveTeam.mockResolvedValueOnce(undefined);

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() =>
      expect(currentTeamMock.setActiveTeam).toHaveBeenCalledWith({
        id: "team-new",
        name: "Trial Team",
        slug: "trial-team",
      }),
    );
    await waitFor(() => expect(screen.getByText("App shell")).toBeInTheDocument());
  });

  it("activates a sole cross-org team instead of creating another team", async () => {
    backendMock.teams.listAllMyTeams.mockResolvedValueOnce([
      { id: "team-other-org", name: "Other Org Team", slug: "other", orgId: "org-b", orgName: "Org B" },
    ]);

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() => expect(currentTeamMock.switchToTeam).toHaveBeenCalledWith("team-other-org"));
    expect(backendMock.teams.createTeam).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText("App shell")).toBeInTheDocument());
  });

  it("extension/web: auto-activates a sole team without showing the chooser", async () => {
    isTauriMock.mockReturnValue(false);
    backendMock.teams.listAllMyTeams.mockResolvedValue([
      { id: "team-existing", name: "Acme", slug: "acme", orgId: "org-1", orgName: "Org", isMember: true },
    ]);
    currentTeamMock.switchToTeam.mockResolvedValueOnce(undefined);

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() => expect(currentTeamMock.switchToTeam).toHaveBeenCalledWith("team-existing"));
    await waitFor(() => expect(screen.getByText("App shell")).toBeInTheDocument());
    expect(screen.queryByText(/Team picker/)).not.toBeInTheDocument();
  });

  it("blocks a teamless user when the server refuses to create an org", async () => {
    // Invite-only is a DEPLOYMENT decision now, not a client build policy: the
    // gate reacts to 403 registration_disabled rather than deciding for itself.
    isTauriMock.mockReturnValue(false);
    backendMock.teams.listAllMyTeams.mockResolvedValue([]);
    backendMock.teams.bootstrapTeam.mockRejectedValueOnce(registrationDisabled());

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() => expect(screen.getByText("暂未加入团队")).toBeInTheDocument());
    expect(screen.getByText("请联系管理员邀请你加入团队。")).toBeInTheDocument();
    expect(authState.refreshPendingInvites).toHaveBeenCalled();
    expect(screen.queryByText("App shell")).not.toBeInTheDocument();
  });

  it("still creates a team when the deployment allows self-registration", async () => {
    isTauriMock.mockReturnValue(false);
    backendMock.teams.listAllMyTeams.mockResolvedValue([]);

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() => expect(backendMock.teams.bootstrapTeam).toHaveBeenCalled());
    // No orgId, no deviceId — the server owns the whole decision now. The
    // display name is best-effort (undefined when the OS name and email are
    // both unavailable, as in this environment) and seeds the actor only.
    expect(Object.keys(backendMock.teams.bootstrapTeam.mock.calls[0][0])).toEqual([
      "displayName",
    ]);
  });

  it("asks before claiming a stashed invite the user has not confirmed (SEC-3)", async () => {
    isTauriMock.mockReturnValue(false);
    authState.pendingInviteToken = "invite-token";
    backendMock.teams.listAllMyTeams.mockResolvedValue([
      { id: "team-1", name: "Existing", slug: "existing", isMember: true },
    ]);

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    // The dialog is asked for, nothing is claimed, and the user's own team
    // bootstraps behind it instead of the gate holding on the answer.
    await waitFor(() =>
      expect(useInviteLinkConfirmation.getState().requested).toBe("invite-token"),
    );
    await waitFor(() => expect(backendMock.teams.listAllMyTeams).toHaveBeenCalled());
    expect(authState.claimPendingInvite).not.toHaveBeenCalled();
  });

  it("waits for a pending invite claim before resolving the team gate", async () => {
    isTauriMock.mockReturnValue(false);
    extensionPolicyMock.isExtension = true;
    extensionPolicyMock.autoCreateTeam = false;
    authState.pendingInviteToken = "invite-token";
    // Accepted in the confirmation dialog this run — the only case AuthGate claims.
    useInviteLinkConfirmation.setState({ confirmedToken: "invite-token" });

    let resolveClaim: (result: { teamId: string }) => void = () => {};
    const claimPromise = new Promise<{ teamId: string }>((resolve) => {
      resolveClaim = resolve;
    });
    authState.claimPendingInvite.mockReturnValue(claimPromise);

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() => expect(authState.claimPendingInvite).toHaveBeenCalled());
    expect(backendMock.teams.listAllMyTeams).not.toHaveBeenCalled();

    resolveClaim({ teamId: "team-invited" });

    await waitFor(() => expect(screen.getByText("App shell")).toBeInTheDocument());
    expect(screen.queryByText("暂未加入团队")).not.toBeInTheDocument();
    expect(backendMock.teams.bootstrapTeam).not.toHaveBeenCalled();
  });

  it("shows contact-matched invitations on the no-team screen", async () => {
    isTauriMock.mockReturnValue(false);
    backendMock.teams.listAllMyTeams.mockResolvedValue([]);
    backendMock.teams.bootstrapTeam.mockRejectedValueOnce(registrationDisabled());
    authState.pendingInvites = [{
      inviteId: "invite-1",
      teamId: "team-invited",
      teamName: "研发协作组",
      teamRole: "member",
      displayName: "New member",
      invitedByDisplayName: "Alice",
      inviteEmail: "new@example.com",
      invitePhone: null,
      expiresAt: null,
      matchedVia: "email",
    }];

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() => expect(screen.getByText("你有团队邀请")).toBeInTheDocument());
    expect(screen.getByText("研发协作组")).toBeInTheDocument();
  });

  it("enters the invited team after the user accepts", async () => {
    isTauriMock.mockReturnValue(false);
    backendMock.teams.listAllMyTeams.mockResolvedValue([]);
    backendMock.teams.bootstrapTeam.mockRejectedValueOnce(registrationDisabled());
    authState.pendingInvites = [{
      inviteId: "invite-1",
      teamId: "team-invited",
      teamName: "研发协作组",
      teamRole: "member",
      displayName: "New member",
      invitedByDisplayName: "Alice",
      inviteEmail: "new@example.com",
      invitePhone: null,
      expiresAt: null,
      matchedVia: "email",
    }];
    authState.acceptPendingInvite.mockResolvedValue({
      actorId: "actor-1",
      teamId: "team-invited",
      actorType: "member",
      displayName: "New member",
      refreshToken: null,
    });

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "接受邀请" }));

    await waitFor(() => expect(screen.getByText("App shell")).toBeInTheDocument());
    expect(authState.acceptPendingInvite).toHaveBeenCalledWith("invite-1");
  });



  it("extension/web: keeps the shell blocked until myTeams resolves, then removes the skeleton", async () => {
    isTauriMock.mockReturnValue(false);
    currentTeamMock.team = { id: "team-cached" };
    currentTeamMock.teamUserId = "user-1";
    let resolveTeams: (teams: unknown[]) => void = () => {};
    backendMock.teams.listAllMyTeams.mockReturnValue(
      new Promise((resolve) => {
        resolveTeams = resolve;
      }),
    );

    const { container } = render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    // Bootstrap is ready from cache, but myTeams is still loading — must keep
    // returning null so the static #skeleton covers the empty #root.
    await waitFor(() => expect(backendMock.teams.listAllMyTeams).toHaveBeenCalled());
    expect(screen.queryByText("App shell")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
    expect(removeStartupSkeletonMock).not.toHaveBeenCalled();

    resolveTeams([]);

    await waitFor(() => expect(screen.getByText("App shell")).toBeInTheDocument());
    expect(removeStartupSkeletonMock).toHaveBeenCalled();
  });
});
