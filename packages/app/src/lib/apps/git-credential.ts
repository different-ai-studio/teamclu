/**
 * Keep this person's git-only token on disk for `amuxd git-credential`
 * (docs/specs/2026-11-16-app-platform-identity-design.md §4–5).
 *
 * After sign-in and on every startup the desktop makes sure
 * `~/.{brand}/git-credential.json` holds a token for the signed-in account that
 * is good for at least another week; otherwise it mints one with
 * `POST /v1/git/token` and hands it to the Rust side, which writes the file
 * (0600) and points the global git config for the git host at the helper.
 * Sign-out revokes every git token of the account and empties the file (the
 * host stays, so the helper can say "not signed in" instead of nothing).
 *
 * Everything here is best-effort: a deployment without per-account git (no
 * GIT_TOKEN_SECRET → 503) simply has no token, and git keeps working the way it
 * did before. A shared support account never gets one.
 */

import { invoke } from "@tauri-apps/api/core";
import { getBackend } from "@/lib/backend";
import { getEffectiveServerConfigSync } from "@/lib/config/server-config";
import { isTauri } from "@/lib/utils";

/** Renew when less than this is left. A token lives 30 days. */
export const GIT_TOKEN_RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;

interface GitCredentialStatus {
  present: boolean;
  userId: string | null;
  expiresAt: string | null;
  gitHost: string | null;
}

/** Whether the stored token can be kept for `userId` at `now`. */
export function gitTokenIsFresh(status: GitCredentialStatus | null, userId: string, now: number): boolean {
  if (!status?.present || status.userId !== userId || !status.expiresAt) return false;
  const expires = Date.parse(status.expiresAt);
  return Number.isFinite(expires) && expires - now > GIT_TOKEN_RENEW_BEFORE_MS;
}

let inflight: Promise<void> | null = null;

/**
 * Make sure the token file is current for this session. Concurrent calls (the
 * auth listener fires on every token refresh) share one round trip.
 */
export function syncGitCredential(
  session: { accessToken?: string | null; user?: { id?: string | null } | null } | null | undefined,
  opts: { isSupportSession?: boolean } = {},
): Promise<void> {
  if (!isTauri() || !session?.accessToken || !session.user?.id || opts.isSupportSession) {
    return Promise.resolve();
  }
  const userId = session.user.id;
  inflight ??= (async () => {
    try {
      const status = await invoke<GitCredentialStatus>("git_credential_status").catch(() => null);
      if (gitTokenIsFresh(status, userId, Date.now())) return;
      const grant = await getBackend().apps.mintGitToken();
      await invoke("git_credential_write", {
        credential: {
          gitHost: grant.gitHost,
          gitScheme: grant.gitScheme === 'http' ? 'http' : 'https',
          apiBase: getEffectiveServerConfigSync().cloudApiUrl ?? null,
          userId: grant.userId,
          userName: grant.userName,
          token: grant.token,
          expiresAt: grant.expiresAt,
        },
      });
    } catch (error) {
      // 503 on a deployment without per-account git is the common case here.
      console.debug("[git-credential] not refreshed:", error);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Sign-out: revoke the account's git tokens everywhere (while the session can
 * still authenticate the call), then clear the local token either way.
 */
export async function revokeGitCredential(): Promise<void> {
  if (!isTauri()) return;
  try {
    await getBackend().apps.revokeGitTokens();
  } catch (error) {
    console.debug("[git-credential] revoke failed (file removed anyway):", error);
  }
  try {
    await invoke("git_credential_clear");
  } catch (error) {
    console.warn("[git-credential] could not remove the local token:", error);
  }
}
