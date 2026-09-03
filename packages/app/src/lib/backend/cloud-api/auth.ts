import type { AuthBackend, AuthClaimResult, AuthSession, PendingInvite, Unsubscribe } from "@/lib/backend/types";
import { BackendError } from "@/lib/backend/errors";
import type { CloudApiClient } from "@/lib/backend/cloud-api/http";
import { isChromeExtension } from "@/lib/config/platform";
import {
  adoptRefreshToken,
  createAuthClient,
  getSession as getStoreSession,
  runDesktopOAuth,
  runExtensionOAuth,
  subscribe as subscribeStore,
  type AuthClient,
  type OAuthProvider,
  type PhoneLoginResult,
  type Session,
} from "@/lib/auth";

function mapSession(session: Session | null): AuthSession | null {
  if (!session) return null;
  const user = session.user;
  // Defensive: a partial session (no user, or user without id) is treated as
  // signed-out rather than crashing the caller. This can happen with stale
  // localStorage entries written by an earlier broken build.
  if (!user || typeof user.id !== "string" || !user.id) return null;
  return {
    user: {
      id: user.id,
      email: user.email ?? null,
      // The Cloud API speaks snake_case; everything above this line is
      // camelCase. This is the ONLY place the two names may both appear.
      isAnonymous: Boolean((user as { is_anonymous?: boolean }).is_anonymous),
      userMetadata:
        (user as { user_metadata?: Record<string, unknown> | null }).user_metadata ?? null,
      providerData: user,
    },
    accessToken: session.access_token ?? null,
    refreshToken: session.refresh_token ?? null,
    expiresAt: session.expires_at ?? null,
    providerData: session,
  };
}

export function createAuthModule(
  client: CloudApiClient,
  authClient: AuthClient,
): AuthBackend {
  return {
    async getSession(): Promise<AuthSession | null> {
      return mapSession(getStoreSession());
    },
    onAuthStateChange(listener: (session: AuthSession | null) => void): Unsubscribe {
      return subscribeStore((_event, session) => listener(mapSession(session)));
    },
    async sendOtp(email: string): Promise<void> {
      await authClient.sendOtp(email, { shouldCreateUser: true });
    },
    async verifyOtp(email: string, code: string): Promise<AuthSession | null> {
      const next = await authClient.verifyOtp(email, code, "email");
      return mapSession(next);
    },
    async sendPhoneOtp(phone: string): Promise<void> {
      await authClient.sendPhoneOtp(phone, { shouldCreateUser: true });
    },
    async verifyPhoneOtp(phone: string, code: string): Promise<AuthSession | null> {
      const next = await authClient.verifyPhoneOtp(phone, code);
      return mapSession(next);
    },
    async verifyPhoneOtpResult(phone: string, code: string): Promise<PhoneLoginResult> {
      return authClient.verifyPhoneOtpResult(phone, code);
    },
    async loginWithPhoneUser(phone: string, code: string, userId: string): Promise<AuthSession | null> {
      const next = await authClient.loginWithPhoneUser(phone, code, userId);
      return mapSession(next);
    },
    async signInWithPassword(email: string, password: string): Promise<AuthSession | null> {
      const next = await authClient.signInWithPassword(email, password);
      return mapSession(next);
    },
    async signInWithOAuth(provider: OAuthProvider): Promise<AuthSession | null> {
      // Same PKCE endpoints either way — only the redirect capture differs, so
      // the runner is picked by platform rather than branching inside it.
      const run = isChromeExtension() ? runExtensionOAuth : runDesktopOAuth;
      const next = await run(authClient, provider);
      return mapSession(next);
    },
    async signOut(): Promise<void> {
      await authClient.signOut();
    },
    async adoptSession(refreshToken: string): Promise<AuthSession | null> {
      const next = await adoptRefreshToken(refreshToken);
      return mapSession(next);
    },
    async claimInvite(token: string): Promise<AuthClaimResult> {
      const claim = await client.post<AuthClaimResult>("/v1/invites/claim", { token });
      if (!claim) {
        throw new BackendError({
          category: "Unknown",
          operation: "auth.claimInvite",
          message: "Invite claim returned no team.",
        });
      }
      // No local `team_mode` is persisted into teamclu.json after a join. The
      // cloud share-mode flag that used to decide it is gone entirely: whether
      // a team can sync is decided by its team secret, in the daemon.
      return claim;
    },
    async listPendingInvites(): Promise<PendingInvite[]> {
      const page = await client.get<{ items: PendingInvite[] }>("/v1/invites/pending");
      return page?.items ?? [];
    },
    async acceptPendingInvite(inviteId: string): Promise<AuthClaimResult> {
      const claim = await client.post<AuthClaimResult>(
        `/v1/invites/${encodeURIComponent(inviteId)}/accept`,
        {},
      );
      if (!claim) {
        throw new BackendError({
          category: "Unknown",
          operation: "auth.acceptPendingInvite",
          message: "Invite accept returned no team.",
        });
      }
      return claim;
    },
    async declinePendingInvite(inviteId: string): Promise<void> {
      await client.post<void>(`/v1/invites/${encodeURIComponent(inviteId)}/decline`, {});
    },
  };
}

export { createAuthClient };
