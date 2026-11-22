import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { authState, backendConfig, serverConfig, extensionPolicy, authFeatures } = vi.hoisted(() => ({
  authFeatures: { emailSelfRegistration: false },
  authState: {
    otpPhone: null,
    phoneMultiUsers: [],
    loading: false,
    errorMessage: null as string | null,
    otpEmail: null as string | null,
    sendOtp: vi.fn(),
    verifyOtp: vi.fn(),
    resetOtp: vi.fn(),
    signInAnonymously: vi.fn(),
  },
  backendConfig: {
    hasConfig: true,
  },
  serverConfig: {
    cloudApiUrl: "https://api.example.com" as string | undefined,
  },
  extensionPolicy: {
    isExtension: false,
    autoCreateTeam: true,
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: () => authState,
}));

vi.mock("@/lib/config/remote-features", () => ({
  useFeatures: () => ({ auth: authFeatures }),
}));

vi.mock("@/lib/backend", () => ({
  hasBackendConfig: () => backendConfig.hasConfig,
}));

vi.mock("@/lib/config/version", () => ({
  useAppVersion: () => "0.1.0",
}));

// Only the resolved URL is faked; displayHost stays real so the footer is
// rendered by the same code the desktop screen uses.
vi.mock("@/lib/config/server-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config/server-config")>()),
  getEffectiveServerConfigSync: () => ({ cloudApiUrl: serverConfig.cloudApiUrl }),
}));

vi.mock("@/lib/config/build-config", () => ({
  buildConfig: { app: { name: "TeamClu" } },
  appDisplayName: "TeamClu",
  extensionTeamOnboarding: extensionPolicy,
}));

vi.mock("@/lib/config/platform", () => ({
  isChromeExtension: () => extensionPolicy.isExtension,
  capabilities: { oauthSignIn: false },
}));

import { LoginScreen } from "../LoginScreen";

beforeEach(() => {
  authFeatures.emailSelfRegistration = false;
  authState.loading = false;
  authState.errorMessage = null;
  authState.otpEmail = null;
  authState.sendOtp.mockReset();
  authState.verifyOtp.mockReset();
  authState.resetOtp.mockReset();
  authState.signInAnonymously.mockReset();
  backendConfig.hasConfig = true;
  serverConfig.cloudApiUrl = "https://api.example.com";
  extensionPolicy.isExtension = false;
  extensionPolicy.autoCreateTeam = true;
});

describe("LoginScreen", () => {
  it("renders the email OTP form", () => {
    render(<LoginScreen />);
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send code/i })).toBeInTheDocument();
  });

  it("advertises account creation only when the deployment offers it", () => {
    const { rerender } = render(<LoginScreen />);
    expect(screen.queryByRole("heading", { name: "Sign in or create an account" })).toBeNull();
    authFeatures.emailSelfRegistration = true;
    rerender(<LoginScreen />);
    expect(screen.getByRole("heading", { name: "Sign in or create an account" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveAttribute("autocomplete", "username");
  });

  it("uses the same OTP flow to register and sign in", async () => {
    authFeatures.emailSelfRegistration = true;
    authState.sendOtp.mockImplementation(async (email: string) => {
      authState.otpEmail = email;
      return true;
    });
    const { rerender } = render(<LoginScreen />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    await waitFor(() => expect(authState.sendOtp).toHaveBeenCalledExactlyOnceWith("new@example.com"));
    rerender(<LoginScreen />);
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "012345" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(authState.verifyOtp).toHaveBeenCalledExactlyOnceWith("012345");
  });

  it("resends to the pending email and prevents immediate repeated resends", async () => {
    authState.otpEmail = "pending@example.com";
    authState.sendOtp.mockResolvedValue(true);
    render(<LoginScreen />);
    expect(screen.getByLabelText("Code")).toHaveAttribute("autocomplete", "one-time-code");
    fireEvent.click(screen.getByRole("button", { name: "Resend code" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /resend in/i })).toBeDisabled());
    expect(authState.sendOtp).toHaveBeenCalledExactlyOnceWith("pending@example.com");
  });

  // Rendering nothing when the URL is unset is how a build with no backend
  // baked in came to look exactly like a working one.
  it("prints the server line even when nothing is configured", () => {
    backendConfig.hasConfig = false;
    serverConfig.cloudApiUrl = undefined;

    render(<LoginScreen />);

    expect(screen.getByText("no server configured")).toBeInTheDocument();
  });

  // Desktop gates this earlier now — the choose screen disables sign-in until a
  // server is set — but a browser build drops straight into this screen, so the
  // guard has to hold here too.
  it("refuses to send a code when no server is configured", () => {
    backendConfig.hasConfig = false;

    render(<LoginScreen />);

    expect(screen.getByText(/no server address is configured/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send code/i })).toBeDisabled();
  });



  it("offers a server switch on the extension login screen", () => {
    extensionPolicy.isExtension = true;

    render(<LoginScreen />);

    expect(screen.getByRole("button", { name: /switch server/i })).toBeInTheDocument();
  });

  it("leaves the server line read-only outside the extension", () => {
    render(<LoginScreen />);

    expect(screen.getByText("api.example.com")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /switch server/i })).not.toBeInTheDocument();
  });

  it("hides anonymous trial only in extension builds that disable automatic team creation", () => {
    extensionPolicy.isExtension = true;
    extensionPolicy.autoCreateTeam = false;

    render(<LoginScreen />);

    expect(screen.queryByRole("button", { name: /try anonymously/i })).not.toBeInTheDocument();
  });


  it("shows error message when signInAnonymously fails", () => {
    authState.errorMessage = "Anonymous sign in failed";
    render(<LoginScreen />);
    expect(screen.getByText(/anonymous sign in failed/i)).toBeInTheDocument();
  });
});
