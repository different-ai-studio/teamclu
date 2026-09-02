import { create } from "zustand";
import { cancelDesktopOAuth, cancelExtensionOAuth, type OAuthProvider } from "@/lib/auth";
import { isChromeExtension } from "@/lib/platform";
import type { PhoneUser } from "@/lib/auth/auth-client";
import { cancelWebSso as libCancelWebSso, runWebSso } from "@/lib/auth/web-sso";
import {
  BACKEND_CONFIG_MISSING_MESSAGE,
  getBackend,
  hasBackendConfig,
} from "@/lib/backend";
import type { AuthClaimResult, AuthSession, PendingInvite } from "@/lib/backend";
import { accessTokenMatchesBackend } from "@/lib/auth/auth-client";
import { CloudApiError } from "@/lib/backend/cloud-api/http";
import { clearBootstrapAppliedFields, fetchAndApplyBootstrap } from "@/lib/bootstrap";
import {
  clearIntrospectAuthBridge,
  syncIntrospectAuthBridge,
} from "@/lib/introspect-auth-bridge";
import { clearSessionFeatures } from "@/lib/remote-features";
import { getEffectiveServerConfig } from "@/lib/server-config";
import { markStartup } from "@/lib/startup-perf";

export type { AuthClaimResult } from "@/lib/backend";

type AuthFlow = "idle" | "invite";

// Held outside the store because the subscription is process-wide, not part of
// the rendered state: `hydrate` may run more than once (StrictMode) and each
// run must replace the previous listener rather than stack another one.
let unsubscribeAuthState: (() => void) | null = null;

type StoreAuthSession = AuthSession & {
  access_token?: string | null;
  refresh_token?: string | null;
  expires_at?: number | null;
};

interface AuthState {
  session: StoreAuthSession | null;
  loading: boolean;
  authFlow: AuthFlow;
  // Which OAuth provider is mid-flight (browser open, loopback awaiting), if any.
  // Drives a cancel affordance so a broken provider page doesn't leave every
  // sign-in button disabled until the long loopback timeout.
  oauthPending: OAuthProvider | null;
  /** True while the Web SSO webview is open and being polled. */
  webSsoPending: boolean;
  signInWithWebSso: () => Promise<boolean>;
  cancelWebSso: () => void;
  errorMessage: string | null;
  otpEmail: string | null;
  otpPhone: string | null;
  /** Users returned when a phone maps to multiple accounts. Non-empty shows the picker. */
  phoneMultiUsers: PhoneUser[];
  /** Stashed OTP token while the multi-user picker is shown. */
  pendingPhoneOTPToken: string;
  selectPhoneUser: (userId: string) => Promise<void>;
  /** Invite token to claim once the user signs in with a real account. */
  pendingInviteToken: string | null;
  hydrate: () => Promise<void>;
  sendOtp: (email: string) => Promise<boolean>;
  verifyOtp: (code: string) => Promise<void>;
  sendPhoneOtp: (phone: string) => Promise<boolean>;
  verifyPhoneOtp: (code: string) => Promise<void>;
  resetOtp: () => void;
  signInWithPassword: (email: string, password: string) => Promise<boolean>;
  signInWithOAuth: (provider: OAuthProvider) => Promise<boolean>;
  cancelOAuth: () => void;
  claimInvite: (token: string) => Promise<AuthClaimResult | null>;
  /** Stash an invite token to claim after the user signs in (real account). */
  setPendingInviteToken: (token: string | null) => void;
  /** Claim the pending invite once the user holds a session. No-op without one. */
  claimPendingInvite: () => Promise<AuthClaimResult | null>;
  /**
   * Invites the server matched to this user's verified email/phone. Unlike
   * `pendingInviteToken` (a link the user opened), these are discovered
   * server-side at login — the user never saw a token.
   */
  pendingInvites: PendingInvite[];
  pendingInvitesLoading: boolean;
  /** Matching keys off the account's verified email/phone. */
  refreshPendingInvites: () => Promise<void>;
  acceptPendingInvite: (inviteId: string) => Promise<AuthClaimResult | null>;
  declinePendingInvite: (inviteId: string) => Promise<boolean>;
  signOut: () => Promise<void>;
}

function errorMessageFor(error: unknown): string {
  return error instanceof Error ? error.message : "Authentication failed.";
}

function storeSession(session: AuthSession | null): StoreAuthSession | null {
  if (!session) return null;
  return {
    ...session,
    access_token: session.accessToken ?? null,
    refresh_token: session.refreshToken ?? null,
    expires_at: session.expiresAt ?? null,
  };
}

// A claim that can never succeed, no matter how many times it is replayed:
// `claim_team_invite` raises for a consumed token, an expired one, and for a
// user who is already a member of the team — the FC repo maps those to 400
// (validation_failed) / 404 (invite invalid) / 409 (already claimed).
// Distinguishing them from a transient failure (offline, 5xx, expired bearer)
// is what lets `claimPendingInvite` drop a dead token instead of retrying it on
// every launch forever.
function isPermanentClaimFailure(error: unknown): boolean {
  return error instanceof CloudApiError && (error.status === 400 || error.status === 404 || error.status === 409);
}

type ClaimFailure = { errorMessage: string; permanent: boolean };

async function claimInviteToken(token: string): Promise<AuthClaimResult | ClaimFailure> {
  try {
    return await getBackend().auth.claimInvite(token);
  } catch (error) {
    return { errorMessage: errorMessageFor(error), permanent: isPermanentClaimFailure(error) };
  }
}

// Pending invite token — stashed when an unauthenticated/anonymous user opens an
// invite, claimed once they sign in with a real account. Persisted so it
// survives the OAuth loopback round-trip and reloads.
const PENDING_INVITE_KEY = "teamclu.pendingInviteToken";

function readPendingInviteToken(): string | null {
  try {
    return localStorage.getItem(PENDING_INVITE_KEY);
  } catch {
    return null;
  }
}

function persistPendingInviteToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(PENDING_INVITE_KEY, token);
    else localStorage.removeItem(PENDING_INVITE_KEY);
  } catch {
    // best-effort: private mode / no localStorage. In-memory state still drives
    // the claim within this session.
  }
}

// After a successful claim, switch into the team and re-onboard the daemon.
async function enterClaimedTeam(teamId: string): Promise<void> {
  const { useCurrentTeamStore } = await import("@/stores/current-team");
  // claim_team_invite moves `public.users.org_id` server-side, but the caller's
  // JWT was minted before that and the claim returns no refresh token on the
  // existing-account path. Activate so this client actually authenticates as
  // the new org — otherwise the team is entered locally and refused remotely.
  await useCurrentTeamStore.getState().enterTeam(teamId);
  try {
    const { isTauri } = await import("@/lib/utils");
    if (isTauri()) {
      const { useDaemonOnboardingStore } = await import("@/stores/daemon-onboarding");
      await useDaemonOnboardingStore.getState().refresh();
    }
  } catch (e) {
    console.warn("[invite] daemon refresh after claim failed", e);
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  session: null,
  loading: true,
  authFlow: "idle",
  oauthPending: null,
  webSsoPending: false,
  errorMessage: null,
  otpEmail: null,
  otpPhone: null,
  phoneMultiUsers: [],
  pendingPhoneOTPToken: "",
  pendingInviteToken: readPendingInviteToken(),
  hydrate: async () => {
    set({ loading: true, authFlow: "idle", errorMessage: null });
    markStartup("auth-hydrate:start");
    let session: AuthSession | null;
    try {
      session = await getBackend().auth.getSession();
      // Drop sessions minted for a different backend (e.g. cloud.ucar.cc) so a
      // local self-host `.env.local` switch doesn't keep sending stale JWTs.
      if (session?.accessToken) {
        const { cloudApiUrl } = await getEffectiveServerConfig();
        if (!accessTokenMatchesBackend(session.accessToken, cloudApiUrl)) {
          await getBackend().auth.signOut();
          session = null;
        }
      }
    } catch (error) {
      // Every await above must land in a defined state. An unhandled throw here
      // used to leave `loading` stuck at true with `session` null while
      // AuthGate's `.finally()` still flipped `authHydrated` — the exact
      // combination that renders the login screen for an already-signed-in user
      // on cold start, and tears the startup skeleton down with it.
      session = null;
      set({ errorMessage: errorMessageFor(error) });
    }
    markStartup("auth-session:end");
    set({ session: storeSession(session), loading: false });
    if (session) {
      void fetchAndApplyBootstrap({ accessToken: session.accessToken });
    }
    void syncIntrospectAuthBridge(session);
    // StrictMode double-invokes the effect that calls hydrate, and this
    // subscription outlives it. Drop the previous one first so a cold start
    // doesn't accumulate listeners that each re-run bootstrap on every auth
    // event.
    unsubscribeAuthState?.();
    unsubscribeAuthState = getBackend().auth.onAuthStateChange((session) => {
      set({ session: storeSession(session) });
      if (session) {
        void fetchAndApplyBootstrap({ accessToken: session.accessToken });
      }
      void syncIntrospectAuthBridge(session);
    });
  },
  sendOtp: async (email) => {
    if (!hasBackendConfig()) {
      set({ loading: false, errorMessage: BACKEND_CONFIG_MISSING_MESSAGE });
      return false;
    }
    set({ loading: true, authFlow: "idle", errorMessage: null });
    try {
      await getBackend().auth.sendOtp(email);
    } catch (error) {
      set({ loading: false, errorMessage: errorMessageFor(error) });
      return false;
    }
    set({ loading: false, otpEmail: email });
    return true;
  },
  verifyOtp: async (code) => {
    if (!hasBackendConfig()) {
      set({ loading: false, errorMessage: BACKEND_CONFIG_MISSING_MESSAGE });
      return;
    }
    const email = get().otpEmail;
    if (!email) {
      set({ errorMessage: "No pending sign-in. Re-enter your email." });
      return;
    }
    set({ loading: true, authFlow: "idle", errorMessage: null });
    try {
      const session = await getBackend().auth.verifyOtp(email, code);
      set({ session: storeSession(session), loading: false, otpEmail: null });
    } catch (error) {
      set({ loading: false, errorMessage: errorMessageFor(error) });
      return;
    }
  },
  sendPhoneOtp: async (phone) => {
    if (!hasBackendConfig()) {
      set({ loading: false, errorMessage: BACKEND_CONFIG_MISSING_MESSAGE });
      return false;
    }
    set({ loading: true, authFlow: "idle", errorMessage: null });
    try {
      await getBackend().auth.sendPhoneOtp(phone);
    } catch (error) {
      set({ loading: false, errorMessage: errorMessageFor(error) });
      return false;
    }
    set({ loading: false, otpPhone: phone });
    return true;
  },
  verifyPhoneOtp: async (code) => {
    if (!hasBackendConfig()) {
      set({ loading: false, errorMessage: BACKEND_CONFIG_MISSING_MESSAGE });
      return;
    }
    const phone = get().otpPhone;
    if (!phone) {
      set({ errorMessage: "No pending sign-in. Re-enter your phone number." });
      return;
    }
    set({ loading: true, authFlow: "idle", errorMessage: null });
    try {
      const result = await getBackend().auth.verifyPhoneOtpResult(phone, code);
      if (result.type === 'multiUser') {
        set({ loading: false, phoneMultiUsers: result.users, pendingPhoneOTPToken: code });
        return;
      }
      set({ session: storeSession(result.session), loading: false, otpPhone: null, phoneMultiUsers: [], pendingPhoneOTPToken: "" });
    } catch (error) {
      set({ loading: false, errorMessage: errorMessageFor(error) });
      return;
    }
  },
  selectPhoneUser: async (userId) => {
    const phone = get().otpPhone;
    const token = get().pendingPhoneOTPToken;
    if (!phone || !token) return;
    set({ loading: true, errorMessage: null });
    try {
      const session = await getBackend().auth.loginWithPhoneUser(phone, token, userId);
      set({ session: storeSession(session), loading: false, otpPhone: null, phoneMultiUsers: [], pendingPhoneOTPToken: "" });
    } catch (error) {
      set({ loading: false, errorMessage: errorMessageFor(error) });
    }
  },
  resetOtp: () => set({ otpEmail: null, otpPhone: null, phoneMultiUsers: [], pendingPhoneOTPToken: "", errorMessage: null }),
  signInWithPassword: async (email, password) => {
    if (!hasBackendConfig()) {
      set({ loading: false, errorMessage: BACKEND_CONFIG_MISSING_MESSAGE });
      return false;
    }
    set({ loading: true, authFlow: "idle", errorMessage: null });
    try {
      const session = await getBackend().auth.signInWithPassword(email, password);
      set({ session: storeSession(session), loading: false, otpEmail: null, otpPhone: null });
      return true;
    } catch (error) {
      set({ loading: false, errorMessage: errorMessageFor(error) });
      return false;
    }
  },
  signInWithOAuth: async (provider) => {
    if (!hasBackendConfig()) {
      set({ loading: false, errorMessage: BACKEND_CONFIG_MISSING_MESSAGE });
      return false;
    }
    set({ loading: true, authFlow: "idle", errorMessage: null, oauthPending: provider });
    try {
      const session = await getBackend().auth.signInWithOAuth(provider);
      set({ session: storeSession(session), loading: false, otpEmail: null, oauthPending: null });
    } catch (error) {
      // A user-initiated cancel is not an error to surface — just re-enable the
      // controls. friendlyError tags cancellations with code "oauth_cancelled".
      const cancelled =
        error instanceof Error &&
        (error as { code?: string }).code === "oauth_cancelled";
      set({
        loading: false,
        oauthPending: null,
        errorMessage: cancelled ? null : errorMessageFor(error),
      });
      return false;
    }
    return true;
  },
  cancelOAuth: () => {
    if (!get().oauthPending) return;
    // Fire-and-forget: the abort makes the in-flight signInWithOAuth promise
    // reject with oauth_cancelled, whose catch block resets the state. The
    // extension has no abort API, so cancelExtensionOAuth races the flow rather
    // than stopping it — Chrome's auth window may outlive this call.
    if (isChromeExtension()) {
      cancelExtensionOAuth();
      return;
    }
    void cancelDesktopOAuth();
  },
  signInWithWebSso: async () => {
    if (!hasBackendConfig()) {
      set({ loading: false, errorMessage: BACKEND_CONFIG_MISSING_MESSAGE });
      return false;
    }
    set({ loading: true, authFlow: "idle", errorMessage: null, webSsoPending: true });
    try {
      const refreshToken = await runWebSso();
      const session = await getBackend().auth.adoptSession(refreshToken);
      set({ session: storeSession(session), loading: false, otpEmail: null, webSsoPending: false });
    } catch (error) {
      const cancelled =
        error instanceof Error && (error as { code?: string }).code === "websso_cancelled";
      set({
        loading: false,
        webSsoPending: false,
        errorMessage: cancelled ? null : errorMessageFor(error),
      });
      return false;
    }
    return true;
  },
  cancelWebSso: () => {
    if (!get().webSsoPending) return;
    libCancelWebSso();
  },
  claimInvite: async (token) => {
    if (!hasBackendConfig()) {
      set({ loading: false, errorMessage: BACKEND_CONFIG_MISSING_MESSAGE });
      return null;
    }
    set({ loading: true, authFlow: "idle", errorMessage: null });
    const result = await claimInviteToken(token);
    if ("errorMessage" in result) {
      set({ loading: false, errorMessage: result.errorMessage });
      return null;
    }
    set({ loading: false });
    return result;
  },
  setPendingInviteToken: (token) => {
    persistPendingInviteToken(token);
    set({ pendingInviteToken: token });
  },
  claimPendingInvite: async () => {
    const token = get().pendingInviteToken;
    if (!token) return null;
    const session = get().session;
    // Member invites require an account. Keep the token pending until sign-in.
    if (!session) return null;
    if (!hasBackendConfig()) {
      set({ errorMessage: BACKEND_CONFIG_MISSING_MESSAGE });
      return null;
    }
    set({ loading: true, authFlow: "invite", errorMessage: null });
    const result = await claimInviteToken(token);
    if ("errorMessage" in result) {
      // Drop a token the server will never accept. Keeping it stranded the
      // account: AuthGate skips team bootstrap while a token is pending, so a
      // dead token left `bootstrap` at "idle" and the gate rendered nothing —
      // a white screen on every launch, after the startup skeleton had already
      // been torn down for the claim splash. Transient failures still retry.
      if (result.permanent) {
        persistPendingInviteToken(null);
        set({ pendingInviteToken: null });
      }
      set({ loading: false, authFlow: "idle", errorMessage: result.errorMessage });
      return null;
    }
    // Consume the token only on success so a transient failure can retry.
    persistPendingInviteToken(null);
    set({ pendingInviteToken: null });
    await enterClaimedTeam(result.teamId);
    set({ loading: false, authFlow: "idle" });
    return result;
  },
  pendingInvites: [],
  pendingInvitesLoading: false,
  refreshPendingInvites: async () => {
    const session = get().session;
    if (!session) {
      set({ pendingInvites: [] });
      return;
    }
    if (!hasBackendConfig()) return;
    set({ pendingInvitesLoading: true });
    try {
      const items = await getBackend().auth.listPendingInvites();
      set({ pendingInvites: items, pendingInvitesLoading: false });
    } catch (error) {
      // Non-fatal and deliberately silent: a failed lookup must not block a
      // sign-in that otherwise succeeded. The user can still join via a link.
      console.warn("[invite] pending invite lookup failed", error);
      set({ pendingInvitesLoading: false });
    }
  },
  acceptPendingInvite: async (inviteId) => {
    if (!hasBackendConfig()) {
      set({ errorMessage: BACKEND_CONFIG_MISSING_MESSAGE });
      return null;
    }
    set({ loading: true, authFlow: "invite", errorMessage: null });
    let result: AuthClaimResult;
    try {
      result = await getBackend().auth.acceptPendingInvite(inviteId);
    } catch (error) {
      set({ loading: false, authFlow: "idle", errorMessage: errorMessageFor(error) });
      return null;
    }
    set({ pendingInvites: get().pendingInvites.filter((i) => i.inviteId !== inviteId) });
    await enterClaimedTeam(result.teamId);
    set({ loading: false, authFlow: "idle" });
    return result;
  },
  declinePendingInvite: async (inviteId) => {
    if (!hasBackendConfig()) {
      set({ errorMessage: BACKEND_CONFIG_MISSING_MESSAGE });
      return false;
    }
    try {
      await getBackend().auth.declinePendingInvite(inviteId);
    } catch (error) {
      set({ errorMessage: errorMessageFor(error) });
      return false;
    }
    set({ pendingInvites: get().pendingInvites.filter((i) => i.inviteId !== inviteId) });
    return true;
  },
  signOut: async () => {
    await getBackend().auth.signOut();
    set({ session: null, authFlow: "idle", otpEmail: null, otpPhone: null, phoneMultiUsers: [], pendingPhoneOTPToken: "", pendingInvites: [] });
    void clearIntrospectAuthBridge();
    // Reset the current team so the NEXT login doesn't inherit
    // the previous user's team. Without this the current-team store kept the old
    // team (its RLS-lag guard preserves it while the new user's team list is
    // momentarily empty), and AuthGate's `if (team) return` then skipped
    // switching — so team actions (e.g. enable OSS share) targeted the previous
    // user's already-locked team and failed with "share mode already locked".
    try {
      const { useCurrentTeamStore } = await import("@/stores/current-team");
      useCurrentTeamStore.setState({
        team: null,
        currentMember: null,
        loading: false,
        error: null,
      });
    } catch (error) {
      console.warn("[auth] reset current-team on signOut failed:", error);
    }
    try {
      const { useWorkspaceStore } = await import("@/stores/workspace");
      await useWorkspaceStore.getState().clearWorkspace();
    } catch (error) {
      console.warn("[auth] clearWorkspace on signOut failed:", error);
    }
    try {
      await clearBootstrapAppliedFields();
    } catch (error) {
      console.warn("[auth] clearBootstrapAppliedFields on signOut failed:", error);
    }
    try {
      // Only the post-sign-in flags. The public snapshot (login methods) is
      // deployment config, not account data — clearing it would send the login
      // screen we are about to show back to the baked defaults.
      clearSessionFeatures();
    } catch (error) {
      console.warn("[auth] clearSessionFeatures on signOut failed:", error);
    }
    try {
      const { resetClientChatState } = await import("@/lib/reset-client-chat-state");
      resetClientChatState();
    } catch (error) {
      console.warn("[auth] resetClientChatState on signOut failed:", error);
    }
    try {
      const { resetMqttReconnectRecovery } = await import("@/stores/mqtt-reconnect");
      resetMqttReconnectRecovery();
    } catch (error) {
      console.warn("[auth] resetMqttReconnectRecovery on signOut failed:", error);
    }
  },
}));
