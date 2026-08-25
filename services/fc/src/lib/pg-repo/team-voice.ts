/**
 * Team voice credentials — pg-repo implementation.
 *
 * One method: mint a short-lived speech credential for a team member. See
 * `lib/aliyun-nls.ts` for why FC mints a token instead of proxying the audio,
 * and why the credentials come from a dedicated `VOICE_*` profile rather than
 * the deployment's default AccessKey.
 *
 * Nothing is persisted. Unlike `setupLiteLlm`, which writes a `litellm_team_id`
 * onto the team, an NLS token is derived state with its own expiry — storing it
 * would create a second copy to invalidate and buy nothing, since minting is a
 * single upstream call.
 */

import type { PgDatabase } from "drizzle-orm/pg-core";
import { ApiError } from "../http-utils.js";
import { requireActorForTeam } from "./authz.js";
import type { NlsToken, VoiceProfile } from "../aliyun-nls.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = PgDatabase<any, any>;

export interface TeamVoiceRepoDeps {
  userId?: string;
  /**
   * Resolves the deployment's voice profile, or explains what is missing.
   * Injected from `aliyun-nls.ts` in production, stubbed in tests.
   */
  resolveVoiceProfile?: () => { profile?: VoiceProfile; error?: string };
  /** Mints the token. Injected so tests never touch the live NLS API. */
  createNlsToken?: (profile: VoiceProfile) => Promise<NlsToken>;
}

export function makeTeamVoiceRepo(db: DbLike, deps: TeamVoiceRepoDeps = {}) {
  return {
    async mintVoiceCredentials(teamId: string) {
      // Membership first, before any upstream call. A non-member must not be
      // able to make this deployment spend an NLS quota, let alone learn
      // whether voice is configured at all.
      await requireActorForTeam(db, deps.userId ?? "", teamId);

      const resolve = deps.resolveVoiceProfile;
      const mint = deps.createNlsToken;
      if (!resolve || !mint) {
        throw new ApiError(
          503,
          "voice_unavailable",
          "voice credential minting is not configured (dependency missing)",
        );
      }

      const { profile, error } = resolve();
      if (!profile) {
        // The reason is surfaced deliberately: "not configured" with no
        // variable named is what made the app-deploy failure cost an SSH
        // session to diagnose. This says which env var is missing — and never
        // its value.
        throw new ApiError(503, "voice_unavailable", error ?? "voice is not configured");
      }

      let token: NlsToken;
      try {
        token = await mint(profile);
      } catch (e) {
        // Upstream failures are 502, not 503: the deployment *is* configured,
        // the vendor call failed. Different cause, different fix.
        throw new ApiError(
          502,
          "voice_upstream_failed",
          e instanceof Error ? e.message : "NLS token request failed",
        );
      }

      return {
        gatewayEndpoint: profile.gatewayEndpoint,
        appKey: profile.appKey,
        token: token.token,
        expiresAt: token.expiresAt,
        sttModel: profile.sttModel,
        ttsVoice: profile.ttsVoice,
      };
    },
  };
}
