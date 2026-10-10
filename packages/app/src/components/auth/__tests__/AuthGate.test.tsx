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

const { getFreshAccessTokenMock } = vi.hoisted(() => ({
  getFreshAccessTokenMock: vi.fn().mockResolvedValue("access-1"),
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
    enterTeam: vi.fn(),
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

vi.mock("@/lib/auth/session-store", () => ({
  getFreshAccessToken: () => getFreshAccessTokenMock(),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(" "),
  isTauri: () => isTauriMock(),
  removeStartupSkeleton: () => removeStartupSkeletonMock(),
}));

vi.mock("@/lib/config/platform", () => ({
  isChromeExtension: () => extensionPolicyMock.isExtension,
}));

vi.mock("@/lib/config/build-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config/build-config")>();
  return {
    ...actual,
    extensionTeamOnboarding: extensionPolicyMock,
  };
});

vi.mock("@/lib/config/extension-auto-create-team", () => ({
  isExtensionAutoCreateTeamEnabled: () => {
    if (!extensionPolicyMock.isExtension) return true;
    return extensionPolicyMock.autoCreateTeam !== false;
  },
}));

// These cases exercise everything *after* first-run onboarding, so present a
// machine that has already answered the language step. The gate itself is
// covered in AuthGateOnboarding.test.tsx.
const onboardingState = {
  languageAck: true,
  markLanguageAck: vi.fn(),
  reset: vi.fn(),
};
vi.mock("@/stores/onboarding", () => ({
  useOnboardingStore: Object.assign(
    (selector: (s: typeof onboardingState) => unknown) => selector(onboardingState),
    { getState: () => onboardingState },
  ),
}));

const { daemonRefreshMock } = vi.hoisted(() => ({
  daemonRefreshMock: vi.fn().mockResolvedValue(undefined),
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
import { useDaemonOnboardingStore } from "@/stores/daemon-onboarding";
import {
  resetInviteLinkConfirmationForTests,
  useInviteLinkConfirmation,
} from "@/lib/team/invite-link-confirmation";
import {
  resetJoinLinkConfirmationForTests,
  useJoinLinkConfirmation,
} from "@/lib/team/join-link-confirmation";
import { resetJoinLinkRedeemForTests } from "@/lib/team/join-link";

beforeEach(() => {
  resetInviteLinkConfirmationForTests();
  resetJoinLinkConfirmationForTests();
  resetJoinLinkRedeemForTests();
  getFreshAccessTokenMock.mockReset();
  getFreshAccessTokenMock.mockResolvedValue("access-1");
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
  currentTeamMock.enterTeam.mockReset();
  currentTeamMock.enterTeam.mockResolvedValue(undefined);
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
  daemonRefreshMock.mockReset();
  daemonRefreshMock.mockResolvedValue(undefined);
  useDaemonOnboardingStore.setState({
    status: "ready",
    loaded: true,
    pendingName: null,
    refresh: daemonRefreshMock,
  });
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

  /*
   * Membership is phone-wide, so an account picked in the phone account picker
   * or the admin console (快捷登录) used to change nothing: its sibling
   * identities' teams in other orgs came back too. The server now flags the
   * rows in the signed-in identity's home org and the login chooser keeps those.
   */
  it("shows only the home org's teams when several remain to choose from", async () => {
    backendMock.teams.listAllMyTeams.mockResolvedValue([
      { id: "team-betly", name: "Betly", slug: "betly", orgId: "org-betly", orgName: "Betly", inHomeOrg: false },
      { id: "team-a1", name: "A1", slug: "a1", orgId: "org-a", orgName: "OrgA", inHomeOrg: true },
      { id: "team-a2", name: "A2", slug: "a2", orgId: "org-a", orgName: "OrgA", inHomeOrg: true },
    ]);

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() => expect(screen.getByText("Team picker: A1, A2")).toBeInTheDocument());
  });

  it("narrows the login chooser to the signed-in account's home org", async () => {
    backendMock.teams.listAllMyTeams.mockResolvedValue([
      { id: "team-betly", name: "Betly", slug: "betly", orgId: "org-betly", orgName: "Betly", inHomeOrg: false },
      { id: "team-test", name: "Test", slug: "test", orgId: "org-test", orgName: "Test", inHomeOrg: false },
      { id: "team-banana", name: "Banana", slug: "banana", orgId: "org-banana", orgName: "Banana", inHomeOrg: true },
    ]);

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() => expect(currentTeamMock.switchToTeam).toHaveBeenCalledWith("team-banana"));
    await waitFor(() => expect(screen.getByText("App shell")).toBeInTheDocument());
    expect(screen.queryByText(/Team picker/)).not.toBeInTheDocument();
  });

  // Sign-out clears the remembered team, so one that survives is a relaunch
  // after the user crossed orgs in Settings — narrowing must not undo that.
  it("keeps a remembered team outside the home org across a relaunch", async () => {
    cachedTeamMock.value = { team: { id: "team-betly" }, teamUserId: "user-1" };
    backendMock.teams.listAllMyTeams.mockResolvedValue([
      { id: "team-betly", name: "Betly", slug: "betly", orgId: "org-betly", orgName: "Betly", inHomeOrg: false },
      { id: "team-banana", name: "Banana", slug: "banana", orgId: "org-banana", orgName: "Banana", inHomeOrg: true },
    ]);

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() => expect(currentTeamMock.switchToTeam).toHaveBeenCalledWith("team-betly"));
    expect(currentTeamMock.switchToTeam).not.toHaveBeenCalledWith("team-banana");
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

  /** Onboarding now stops at the first-run naming screen; get past it. */
  async function nameTheTeam(name = "Trial Team") {
    const input = await screen.findByLabelText("给你的团队起个名字");
    fireEvent.change(input, { target: { value: name } });
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
  }

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

    // No team is created until the user has named one.
    await nameTheTeam();
    // The submit resolves the actor display name first, so the call lands on a
    // later tick.
    await waitFor(() =>
      expect(backendMock.teams.bootstrapTeam).toHaveBeenCalledWith(
        expect.objectContaining({ teamName: "Trial Team" }),
      ),
    );

    // Activate before setting the client team: bootstrap can move the caller's
    // org, and current_org_id() reads the JWT claim before public.users.org_id.
    await waitFor(() => expect(currentTeamMock.enterTeam).toHaveBeenCalledWith("team-new"));
    await waitFor(() =>
      expect(currentTeamMock.setActiveTeam).toHaveBeenCalledWith({
        id: "team-new",
        name: "Trial Team",
        slug: "trial-team",
      }),
    );
    await waitFor(() => expect(screen.getByText("App shell")).toBeInTheDocument());
  });

  it("does not create anything until the name is submitted", async () => {
    backendMock.teams.listAllMyTeams.mockResolvedValueOnce([]);

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await screen.findByLabelText("给你的团队起个名字");
    expect(backendMock.teams.bootstrapTeam).not.toHaveBeenCalled();
    expect(screen.queryByText("App shell")).not.toBeInTheDocument();
  });

  it("lets the user retype after a failed creation instead of restarting onboarding", async () => {
    backendMock.teams.listAllMyTeams.mockResolvedValueOnce([]);
    backendMock.teams.bootstrapTeam.mockRejectedValueOnce(new Error("boom"));

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await nameTheTeam("First Try");
    // Still on the naming screen, with the team list probe not re-run.
    await screen.findByLabelText("给你的团队起个名字");
    expect(backendMock.teams.listAllMyTeams).toHaveBeenCalledTimes(1);

    backendMock.teams.bootstrapTeam.mockResolvedValueOnce({
      id: "team-2",
      name: "Second Try",
      slug: "second-try",
    });
    await nameTheTeam("Second Try");
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

  it("extension: invite-only build skips first-team naming when autoCreateTeam is off", async () => {
    isTauriMock.mockReturnValue(false);
    extensionPolicyMock.isExtension = true;
    extensionPolicyMock.autoCreateTeam = false;
    backendMock.teams.listAllMyTeams.mockResolvedValue([]);

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() => expect(screen.getByText("暂未加入团队")).toBeInTheDocument());
    expect(screen.getByText("请联系管理员邀请你加入团队。")).toBeInTheDocument();
    expect(backendMock.teams.bootstrapTeam).not.toHaveBeenCalled();
    expect(authState.refreshPendingInvites).toHaveBeenCalled();
    expect(screen.queryByText("App shell")).not.toBeInTheDocument();
  });

  it("blocks a teamless user when the server refuses to create an org", async () => {
    isTauriMock.mockReturnValue(false);
    backendMock.teams.listAllMyTeams.mockResolvedValue([]);
    backendMock.teams.bootstrapTeam.mockRejectedValueOnce(registrationDisabled());

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await nameTheTeam();
    await waitFor(() => expect(screen.getByText("暂未加入团队")).toBeInTheDocument());
    expect(screen.getByText("请联系管理员邀请你加入团队。")).toBeInTheDocument();
    expect(authState.refreshPendingInvites).toHaveBeenCalled();
    expect(screen.queryByText("App shell")).not.toBeInTheDocument();
  });

  it("says why when it signs the user out after a rejected team bootstrap", async () => {
    backendMock.teams.listAllMyTeams.mockRejectedValueOnce(
      new CloudApiError(401, "missing_auth", "Invalid or expired access token", null),
    );

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() =>
      expect(authState.signOut).toHaveBeenCalledWith(
        "team_bootstrap_auth_rejected",
        expect.stringContaining("401 missing_auth"),
      ),
    );
  });

  it("names the no-team screen when its sign-out button is used", async () => {
    isTauriMock.mockReturnValue(false);
    backendMock.teams.listAllMyTeams.mockResolvedValue([]);
    backendMock.teams.bootstrapTeam.mockRejectedValueOnce(registrationDisabled());

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await nameTheTeam();
    await waitFor(() => expect(screen.getByText("暂未加入团队")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "退出登录并使用其他账号" }));

    expect(authState.signOut).toHaveBeenCalledWith("no_team_screen");
  });

  it("still creates a team when the deployment allows self-registration", async () => {
    isTauriMock.mockReturnValue(false);
    backendMock.teams.listAllMyTeams.mockResolvedValue([]);

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await nameTheTeam("Acme");
    await waitFor(() => expect(backendMock.teams.bootstrapTeam).toHaveBeenCalled());
    // No orgId, no deviceId — the server owns the whole decision now. The
    // display name is best-effort (undefined when the OS name and email are
    // both unavailable, as in this environment) and seeds the ACTOR only;
    // teamName is what names the org and its default team.
    expect(Object.keys(backendMock.teams.bootstrapTeam.mock.calls[0][0]).sort()).toEqual([
      "displayName",
      "teamName",
    ]);
    expect(backendMock.teams.bootstrapTeam.mock.calls[0][0].teamName).toBe("Acme");
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

  it("joins from a confirmed join link after session appears and never claims an invite", async () => {
    isTauriMock.mockReturnValue(false);
    authState.session = null;
    useJoinLinkConfirmation.setState({
      requested: null,
      confirmed: { token: "join-tok", cloudApiUrl: "https://api.acme.test" },
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ teamId: "team-join", alreadyMember: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() => expect(screen.getByText("Login screen")).toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(authState.claimPendingInvite).not.toHaveBeenCalled();

    authState.session = { user: { id: "user-1" } };
    view.rerender(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() => expect(currentTeamMock.enterTeam).toHaveBeenCalledWith("team-join"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.acme.test/v1/join-links/join-tok/join");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer access-1" },
    });
    expect(authState.claimPendingInvite).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("enters the joined team without naming a new one or switching teams", async () => {
    isTauriMock.mockReturnValue(false);
    authState.session = null;
    backendMock.teams.listAllMyTeams.mockResolvedValue([]);
    useJoinLinkConfirmation.setState({
      requested: null,
      confirmed: { token: "join-tok", cloudApiUrl: "https://api.acme.test" },
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ teamId: "team-join", alreadyMember: false }),
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const view = render(
        <AuthGate>
          <div>App shell</div>
        </AuthGate>,
      );

      await waitFor(() => expect(screen.getByText("Login screen")).toBeInTheDocument());

      authState.session = { user: { id: "user-1" } };
      view.rerender(
        <AuthGate>
          <div>App shell</div>
        </AuthGate>,
      );

      await waitFor(() => expect(currentTeamMock.enterTeam).toHaveBeenCalledWith("team-join"));
      await waitFor(() => expect(screen.getByText("App shell")).toBeInTheDocument());
      expect(currentTeamMock.switchToTeam).not.toHaveBeenCalled();
      expect(screen.queryByLabelText("给你的团队起个名字")).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("marks daemon onboarding loaded after a join without calling refresh", async () => {
    useDaemonOnboardingStore.setState({ status: "unknown", loaded: false });
    authState.session = null;
    backendMock.teams.listAllMyTeams.mockResolvedValue([]);
    useJoinLinkConfirmation.setState({
      requested: null,
      confirmed: { token: "join-tok", cloudApiUrl: "https://api.acme.test" },
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ teamId: "team-join", alreadyMember: false }),
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const view = render(
        <AuthGate>
          <div>App shell</div>
        </AuthGate>,
      );

      await waitFor(() => expect(screen.getByText("Desktop onboarding")).toBeInTheDocument());

      authState.session = { user: { id: "user-1" } };
      view.rerender(
        <AuthGate>
          <div>App shell</div>
        </AuthGate>,
      );

      await waitFor(() => expect(currentTeamMock.enterTeam).toHaveBeenCalledWith("team-join"));
      await waitFor(() => expect(screen.getByText("App shell")).toBeInTheDocument());
      expect(useDaemonOnboardingStore.getState().loaded).toBe(true);
      expect(daemonRefreshMock).not.toHaveBeenCalled();
      expect(screen.queryByText("Daemon onboarding wizard")).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not stay on no_team when listAllMyTeams 403s after a successful join", async () => {
    isTauriMock.mockReturnValue(false);
    let rejectTeams: (error: unknown) => void = () => {};
    backendMock.teams.listAllMyTeams.mockReturnValue(
      new Promise((_, reject) => {
        rejectTeams = reject;
      }),
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ teamId: "team-join", alreadyMember: false }),
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const view = render(
        <AuthGate>
          <div>App shell</div>
        </AuthGate>,
      );

      await waitFor(() => expect(backendMock.teams.listAllMyTeams).toHaveBeenCalled());

      useJoinLinkConfirmation.setState({
        requested: null,
        confirmed: { token: "join-tok", cloudApiUrl: "https://api.acme.test" },
      });
      view.rerender(
        <AuthGate>
          <div>App shell</div>
        </AuthGate>,
      );

      await waitFor(() => expect(currentTeamMock.enterTeam).toHaveBeenCalledWith("team-join"));
      const inviteCallsBefore403 = authState.refreshPendingInvites.mock.calls.length;
      rejectTeams(registrationDisabled());
      await waitFor(() =>
        expect(authState.refreshPendingInvites.mock.calls.length).toBeGreaterThan(inviteCallsBefore403),
      );

      await waitFor(() => {
        expect(screen.queryByText("暂未加入团队")).not.toBeInTheDocument();
        expect(screen.queryByLabelText("给你的团队起个名字")).not.toBeInTheDocument();
        expect(screen.getByText("App shell")).toBeInTheDocument();
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows a revoked join link after sign-in and does not enter a team", async () => {
    isTauriMock.mockReturnValue(false);
    authState.session = null;
    useJoinLinkConfirmation.setState({
      requested: null,
      confirmed: { token: "join-tok", cloudApiUrl: "https://api.acme.test" },
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 410,
      text: async () => JSON.stringify({ error: { code: "link_revoked" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const view = render(
        <AuthGate>
          <div>App shell</div>
        </AuthGate>,
      );

      await waitFor(() => expect(screen.getByText("Login screen")).toBeInTheDocument());

      authState.session = { user: { id: "user-1" } };
      view.rerender(
        <AuthGate>
          <div>App shell</div>
        </AuthGate>,
      );

      await waitFor(() => expect(screen.getByText("这条链接已停用")).toBeInTheDocument());
      expect(currentTeamMock.enterTeam).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
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

    // An empty list is now the first-run naming screen, not an auto-created
    // team — but it is still real, interactive UI, so the skeleton comes down.
    await nameTheTeam();
    await waitFor(() => expect(screen.getByText("App shell")).toBeInTheDocument());
    expect(removeStartupSkeletonMock).toHaveBeenCalled();
  });
});
