import type { CloudAuthClient } from "../auth/cloud-auth";
import type { BootstrapResult, TeamSummary } from "../../features/onboarding/onboarding-types";
import {
  parseOAuthCallbackUrl,
  type OAuthProvider,
} from "../../features/onboarding/onboarding-oauth";

/**
 * Cloud-only onboarding/auth API. Backed by the Cloud API auth facade
 * (`CloudAuthClient`): auth flows hit FC `/v1/auth/*`, business reads hit
 * `GET /v1/teams` and team activation. Mirrors iOS
 * `CloudAPIAppOnboardingStore`.
 *
 * The `client` parameter is the same `supabase` facade the rest of the app
 * imports — kept as an injected dependency so tests can substitute fakes.
 */

type CloudTeamPage = { items?: CloudTeam[] };
type CloudTeam = { id: string; name: string; slug?: string | null };
type MembershipTeam = CloudTeam & { role?: string | null; isMember?: boolean };
type TeamActivation = { actorId?: string | null; refreshToken: string };

import {
  resolveBootstrapDecision,
  type BootstrapTeam,
} from "../../features/onboarding/bootstrap-route";

export function createOnboardingApi(client: CloudAuthClient) {
  return {
    async getCurrentSession() {
      const { data } = await client.auth.getSession();
      return data.session ?? null;
    },

    async loadBootstrap(rememberedTeamId?: string | null): Promise<BootstrapResult> {
      const session = await this.getCurrentSession();
      if (!session?.user?.id) {
        return { isAnonymous: false, team: null, memberActorId: null, teamChoices: [] };
      }

      const isAnonymous = Boolean(session.user.is_anonymous);
      // scope=all, because the decision is about which org to activate and the
      // default listing only covers the org already active. It is also the only
      // listing that carries orgName, which the picker groups by.
      const dto = await client.api.get<CloudTeamPage>("/v1/teams?scope=all");
      const teams: BootstrapTeam[] = ((dto.items as MembershipTeam[] | undefined) ?? [])
        .filter((team) => team.isMember !== false)
        .map((team) => ({
          id: team.id,
          name: team.name ?? "Unnamed team",
          slug: team.slug ?? "",
          role: team.role ?? "member",
          orgName: (team as { orgName?: string | null }).orgName ?? null,
        }));

      const decision = resolveBootstrapDecision({ teams, rememberedTeamId });
      if (decision.kind === "createTeam") {
        return { isAnonymous, team: null, memberActorId: null, teamChoices: [] };
      }
      if (decision.kind === "selectTeam") {
        // Deliberately no activate call. Activating to show a picker would put
        // the session in an org the user may be about to navigate away from.
        return { isAnonymous, team: null, memberActorId: null, teamChoices: decision.teams };
      }

      const adopted = teams.find((team) => team.id === decision.teamId) ?? teams[0];
      const memberActorId = await this.activateTeam(adopted.id);
      return {
        isAnonymous,
        team: {
          id: adopted.id,
          name: adopted.name,
          slug: adopted.slug,
          role: adopted.role,
        },
        memberActorId,
        teamChoices: [],
      };
    },

    /**
     * Makes `teamId` the session's active team and returns the caller's actor
     * id within it.
     *
     * Separate from the listing because the picker path defers it: nothing is
     * activated until the user has chosen.
     */
    async activateTeam(teamId: string): Promise<string | null> {
      const activation = await client.api.post<TeamActivation>(
        `/v1/teams/${encodeURIComponent(teamId)}/activate`,
      );
      if (activation.refreshToken) {
        const result = await client.auth.setRefreshSession(activation.refreshToken);
        if (result.error) throw new Error(result.error.message);
      }
      return activation.actorId ?? null;
    },

    /**
     * Adopt a session minted server-side (e.g. by accepting an invite, which
     * may land the user in another org). Silent, like the activation path, so
     * it does not race a bootstrap through the auth listener.
     */
    async adoptRefreshSession(refreshToken: string): Promise<void> {
      const result = await client.auth.setRefreshSession(refreshToken);
      if (result.error) throw new Error(result.error.message);
    },

    async sendEmailOTP(email: string) {
      await client.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
      return { pendingEmail: email };
    },

    async verifyOTP(email: string, token: string) {
      const { error } = await client.auth.verifyOtp({ email, token, type: "email" });
      if (error) throw new Error(error.message);
    },

    async signInWithPassword(email: string, password: string) {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message);
    },

    async createOAuthSignInUrl(provider: OAuthProvider, redirectTo: string) {
      return client.auth.oauthAuthorize(provider, redirectTo);
    },

    async createOAuthLinkUrl(provider: OAuthProvider, redirectTo: string) {
      // The FC OAuth authorize endpoint cannot link to the current user via a
      // browser redirect (no bearer forwarded), so linking behaves as
      // sign-in-with-provider through the same PKCE flow.
      return client.auth.oauthAuthorize(provider, redirectTo);
    },

    async completeOAuthCallback(callbackUrl: string) {
      const callback = parseOAuthCallbackUrl(callbackUrl);
      if (callback.type === "code") {
        return client.auth.exchangeOAuthCode(callback.code);
      }
      return client.auth.setSession({
        access_token: callback.accessToken,
        refresh_token: callback.refreshToken,
      });
    },

    async createTeam(name: string): Promise<TeamSummary> {
      const team = await client.api.post<CloudTeam>("/v1/teams", { name });
      if (!team?.id) {
        throw new Error("create team returned no team id");
      }
      // POST /v1/teams returns only the team row; membership is available from
      // the canonical team listing rather than a synthetic /me bootstrap.
      const dto = await client.api.get<CloudTeamPage>("/v1/teams");
      const role = (dto.items as MembershipTeam[] | undefined)?.find((t) => t.id === team.id)?.role ?? "owner";
      return {
        id: team.id,
        name: team.name,
        slug: team.slug ?? "",
        role,
      };
    },

    async signOut() {
      await client.auth.signOut();
    },
  };
}
