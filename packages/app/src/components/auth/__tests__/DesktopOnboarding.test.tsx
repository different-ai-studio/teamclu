import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const {
  authState,
  hasConfig,
  reload,
  cloudApiUrlOverride,
  setCloudApiUrlOverrideMock,
  probeCloudApi,
  effectiveCloudApiUrl,
  defaultCloudApiUrl,
  confirmInviteLinkToken,
} = vi.hoisted(() => ({
  authState: {
    loading: false,
    errorMessage: null as string | null,
    otpEmail: null as string | null,
    pendingInviteToken: null as string | null,
    setPendingInviteToken: vi.fn(),
    sendOtp: vi.fn(),
    verifyOtp: vi.fn(),
    resetOtp: vi.fn(),
  },
  hasConfig: { value: true },
  reload: vi.fn(),
  cloudApiUrlOverride: { value: null as string | null },
  setCloudApiUrlOverrideMock: vi.fn(),
  probeCloudApi: vi.fn(),
  effectiveCloudApiUrl: { value: "https://teamclu-api.ucar.cc" as string | undefined },
  defaultCloudApiUrl: { value: "https://teamclu-api.ucar.cc" as string | undefined },
  confirmInviteLinkToken: vi.fn(),
}));

vi.mock("@/lib/config/bootstrap", () => ({ probeCloudApi }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock("@/stores/auth-store", () => {
  const useAuthStore = (selector?: (state: typeof authState) => unknown) =>
    selector ? selector(authState) : authState;
  // The wizard reads the pending token imperatively to decide its first step.
  useAuthStore.getState = () => authState;
  return { useAuthStore };
});

vi.mock("@/lib/team/invite-link-confirmation", () => ({ confirmInviteLinkToken }));

// Only the resolved values are faked; displayHost / normalizeCloudApiUrl stay
// real so the screen formats and validates addresses the way production does.
vi.mock("@/lib/config/server-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config/server-config")>()),
  // Mirrors production: `resolve()` returns the override when there is one, so
  // a test that sets an override and a different effective URL is describing a
  // state the app cannot be in.
  getEffectiveServerConfigSync: () => ({
    cloudApiUrl: cloudApiUrlOverride.value ?? effectiveCloudApiUrl.value,
  }),
  getCloudApiUrlOverride: () => cloudApiUrlOverride.value,
  getDefaultCloudApiUrl: () => defaultCloudApiUrl.value,
  setCloudApiUrlOverride: setCloudApiUrlOverrideMock,
}));

vi.mock("@/lib/backend", () => ({
  hasBackendConfig: () => hasConfig.value,
  getBackendKind: () => "cloud_api",
}));

vi.mock("@/lib/config/version", () => ({
  useAppVersion: () => "0.1.0",
}));

vi.mock("@/lib/config/build-config", () => ({
  buildConfig: { app: { name: "TeamClu" } },
  appScheme: 'teamclu',
  deeplinkSchemes: ['teamclu', 'teamclaw', 'amux'],
  // The onboarding + setup stores key their localStorage off these.
  appStoragePrefix: 'teamclu',
  localAgent: 'opencode',
}));

import { DesktopOnboarding } from "../DesktopOnboarding";
import { useOnboardingStore } from "@/stores/onboarding";

const INVITE_WITH_SERVER = "teamclu://invite?token=tok-1&cloud_api_url=https%3A%2F%2Fapi.acme.test";

/** Fill the invite box and submit the step. */
function submitInvite(value: string) {
  fireEvent.change(screen.getByRole("textbox"), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
}

beforeEach(() => {
  authState.loading = false;
  authState.errorMessage = null;
  authState.otpEmail = null;
  authState.pendingInviteToken = null;
  authState.setPendingInviteToken.mockReset();
  authState.sendOtp.mockReset();
  authState.verifyOtp.mockReset();
  authState.resetOtp.mockReset();
  confirmInviteLinkToken.mockReset();
  hasConfig.value = true;
  cloudApiUrlOverride.value = null;
  effectiveCloudApiUrl.value = "https://teamclu-api.ucar.cc";
  defaultCloudApiUrl.value = "https://teamclu-api.ucar.cc";
  setCloudApiUrlOverrideMock.mockReset();
  probeCloudApi.mockReset();
  probeCloudApi.mockResolvedValue({ ok: true });
  useOnboardingStore.setState({ serverAck: false });
  Object.defineProperty(window, "location", {
    value: { reload },
    writable: true,
    configurable: true,
  });
  reload.mockReset();
});

describe("DesktopOnboarding", () => {
  it("opens on the invite question, not on a menu of setup types", () => {
    const { container } = render(<DesktopOnboarding />);

    expect(container.querySelector("[data-tauri-drag-region]")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /do you have an invite link/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /i don't have an invite link/i })).toBeInTheDocument();
    // Nothing to sign in with yet: the server has not been settled.
    expect(screen.queryByRole("heading", { name: /sign in/i })).not.toBeInTheDocument();
  });

  it("rejects input that is neither a link nor a token", () => {
    render(<DesktopOnboarding />);

    submitInvite("https://example.com/invite/abc");

    expect(screen.getByText(/enter a valid invite token or invite link/i)).toBeInTheDocument();
    expect(authState.setPendingInviteToken).not.toHaveBeenCalled();
  });

  // The whole point of 2.1: the link names its own backend, so the invitee is
  // never asked to type an address.
  it("takes the server address off the invite link, probes it, and goes to sign-in", async () => {
    render(<DesktopOnboarding />);

    submitInvite(INVITE_WITH_SERVER);

    await waitFor(() =>
      expect(probeCloudApi).toHaveBeenCalledWith("https://api.acme.test"),
    );
    expect(setCloudApiUrlOverrideMock).toHaveBeenCalledWith("https://api.acme.test");
    expect(authState.setPendingInviteToken).toHaveBeenCalledWith("tok-1");
    // Typed by the user, so it must not raise the deep-link confirmation later.
    expect(confirmInviteLinkToken).toHaveBeenCalledWith("tok-1");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument(),
    );
    // A reload would restart the wizard and drop the confirmation.
    expect(reload).not.toHaveBeenCalled();
  });

  it("skips the server step for a link, going straight from invite to sign-in", async () => {
    render(<DesktopOnboarding />);

    submitInvite(INVITE_WITH_SERVER);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("heading", { name: /which server/i })).not.toBeInTheDocument();
  });

  it("holds the invite when its server does not answer, then continues on demand", async () => {
    probeCloudApi.mockResolvedValue({ ok: false, reason: "unreachable" });
    render(<DesktopOnboarding />);

    submitInvite(INVITE_WITH_SERVER);

    await waitFor(() => expect(screen.getByText(/could not reach that address/i)).toBeInTheDocument());
    expect(setCloudApiUrlOverrideMock).not.toHaveBeenCalled();
    expect(authState.setPendingInviteToken).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /continue anyway/i }));

    expect(setCloudApiUrlOverrideMock).toHaveBeenCalledWith("https://api.acme.test");
    expect(authState.setPendingInviteToken).toHaveBeenCalledWith("tok-1");
  });

  it("claims a bare token against the server already in effect", async () => {
    render(<DesktopOnboarding />);

    submitInvite("tok-bare");

    await waitFor(() => expect(authState.setPendingInviteToken).toHaveBeenCalledWith("tok-bare"));
    expect(probeCloudApi).not.toHaveBeenCalled();
    expect(setCloudApiUrlOverrideMock).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument(),
    );
  });

  // A bare token with nothing to claim it against has to ask for a server.
  it("asks for a server when a bare token arrives on a build with none", async () => {
    effectiveCloudApiUrl.value = undefined;
    defaultCloudApiUrl.value = undefined;
    render(<DesktopOnboarding />);

    submitInvite("tok-bare");

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /custom server/i })).toBeInTheDocument(),
    );
    expect(authState.setPendingInviteToken).toHaveBeenCalledWith("tok-bare");
  });

  it("offers the official server and a custom one when there is no invite", () => {
    render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /i don't have an invite link/i }));

    expect(screen.getByRole("heading", { name: /which server do you sign in to/i })).toBeInTheDocument();
    // The row names the address, so "official" is not a leap of faith. The
    // footer prints it too, hence the scoped lookup.
    const official = screen.getByRole("button", { name: /official server/i });
    expect(official).toHaveTextContent("teamclu-api.ucar.cc");
  });

  it("clears any override when the official server is chosen", async () => {
    cloudApiUrlOverride.value = "https://api.acme.test";
    render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /i don't have an invite link/i }));
    fireEvent.click(screen.getByRole("button", { name: /official server/i }));

    expect(setCloudApiUrlOverrideMock).toHaveBeenCalledWith(null);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument(),
    );
    expect(reload).not.toHaveBeenCalled();
  });

  it("probes a custom address before applying it", async () => {
    render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /i don't have an invite link/i }));
    fireEvent.click(screen.getByRole("button", { name: /custom server/i }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://api.acme.test" } });
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));

    await waitFor(() => expect(probeCloudApi).toHaveBeenCalledWith("https://api.acme.test"));
    expect(setCloudApiUrlOverrideMock).toHaveBeenCalledWith("https://api.acme.test");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument(),
    );
  });

  it("rejects a scheme-less address without asking the network", async () => {
    render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /i don't have an invite link/i }));
    fireEvent.click(screen.getByRole("button", { name: /custom server/i }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "api.acme.test" } });
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));

    await waitFor(() => expect(screen.getByText(/enter a valid http\(s\) url/i)).toBeInTheDocument());
    expect(probeCloudApi).not.toHaveBeenCalled();
    expect(setCloudApiUrlOverrideMock).not.toHaveBeenCalled();
  });

  it("saves an unverified address once the user insists", async () => {
    probeCloudApi.mockResolvedValue({ ok: false, reason: "not-cloud-api", status: 404 });
    render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /i don't have an invite link/i }));
    fireEvent.click(screen.getByRole("button", { name: /custom server/i }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://api.acme.test" } });
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));

    await waitFor(() => expect(screen.getByText(/not a TeamClu Cloud API/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /save it anyway/i }));

    expect(setCloudApiUrlOverrideMock).toHaveBeenCalledWith("https://api.acme.test");
  });

  // A build with nothing baked in has no official server to offer.
  it("collapses to the custom form when the build ships no default", () => {
    effectiveCloudApiUrl.value = undefined;
    defaultCloudApiUrl.value = undefined;
    render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /i don't have an invite link/i }));

    expect(screen.queryByRole("button", { name: /official server/i })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /custom server/i })).toBeInTheDocument();
    expect(screen.getByText(/this build ships no server address/i)).toBeInTheDocument();
  });

  it("goes straight to sign-in once the server question has been answered before", () => {
    useOnboardingStore.setState({ serverAck: true });
    render(<DesktopOnboarding />);

    expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /do you have an invite link/i })).not.toBeInTheDocument();
  });

  it("goes straight to sign-in when a deep link already stashed a token", () => {
    authState.pendingInviteToken = "tok-from-deeplink";
    render(<DesktopOnboarding />);

    expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument();
  });

  it("re-runs the whole wizard on demand", () => {
    useOnboardingStore.getState().markServerAck();
    render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /run setup again/i }));

    expect(useOnboardingStore.getState().serverAck).toBe(false);
    expect(reload).toHaveBeenCalled();
  });

  it("prints the effective address, marking a custom one", () => {
    cloudApiUrlOverride.value = "https://api.acme.test";
    render(<DesktopOnboarding />);

    expect(screen.getByText(/api\.acme\.test/)).toBeInTheDocument();
    expect(screen.getByText(/custom/)).toBeInTheDocument();
  });

  it("says so when the build has no server at all", () => {
    effectiveCloudApiUrl.value = undefined;
    defaultCloudApiUrl.value = undefined;
    render(<DesktopOnboarding />);

    expect(screen.getByText(/no server configured/i)).toBeInTheDocument();
  });
});
