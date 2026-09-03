import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { authState, backendConfig, serverConfig, extensionPolicy } = vi.hoisted(() => ({
  authState: {
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
