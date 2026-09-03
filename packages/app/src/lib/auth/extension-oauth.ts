// Chrome MV3 OAuth orchestration: chrome.identity.launchWebAuthFlow + PKCE
// exchange. The desktop twin of this file (desktop-oauth.ts) captures the
// redirect with a native loopback listener; an extension has no such thing, so
// Chrome's own auth window stands in and hands back the final redirect URL.
//
// Everything below the redirect capture is identical to desktop: same FC PKCE
// endpoints (`/v1/auth/oauth/:provider/authorize` + `/exchange`), same verifier
// handling. Only the transport differs.
//
// The redirect lands on `https://<extension-id>.chromiumapp.org/`, which Chrome
// synthesises and never actually loads. GoTrue still validates it against
// GOTRUE_URI_ALLOW_LIST (deploy: ADDITIONAL_REDIRECT_URLS), so a new extension
// id needs an entry there or the provider round-trip fails with a redirect
// mismatch — see deploy/self-host/.env.example.

import type { AuthClient } from "@/lib/auth/auth-client";
import type { OAuthProvider } from "@/lib/auth/desktop-oauth";
import { generatePkce } from "@/lib/auth/oauth-pkce";
import { AuthError, type Session } from "@/lib/auth/types";

/**
 * Structural shape of the slice of `chrome.identity` we use. Declared here
 * rather than pulled from @types/chrome because packages/app builds for desktop
 * and web too, where that global does not exist.
 */
interface ChromeIdentityLike {
  getRedirectURL(path?: string): string;
  launchWebAuthFlow(
    details: { url: string; interactive: boolean },
    callback: (responseUrl?: string) => void,
  ): void;
}

interface ChromeRuntimeLike {
  lastError?: { message?: string };
}

function readChrome(): { identity?: ChromeIdentityLike; runtime?: ChromeRuntimeLike } | undefined {
  if (typeof globalThis === "undefined") return undefined;
  return (globalThis as { chrome?: { identity?: ChromeIdentityLike; runtime?: ChromeRuntimeLike } }).chrome;
}

/**
 * Chrome reports a closed auth window as a generic lastError rather than a
 * dedicated code, so match on the phrasing it actually uses. Anything we cannot
 * confidently read as a cancel stays a real failure — mislabelling a broken
 * provider as "cancelled" would swallow the error message the user needs.
 */
function isCancelMessage(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("did not approve") ||
    m.includes("canceled") ||
    m.includes("cancelled") ||
    m.includes("closed by the user")
  );
}

function friendlyError(message: string): AuthError {
  if (isCancelMessage(message)) {
    return new AuthError("Sign-in was cancelled.", 0, "oauth_cancelled");
  }
  return new AuthError(message || "OAuth sign-in failed.", 0, "oauth_failed");
}

let activeCancel: (() => void) | null = null;

function launchWebAuthFlow(identity: ChromeIdentityLike, url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    identity.launchWebAuthFlow({ url, interactive: true }, responseUrl => {
      const lastError = readChrome()?.runtime?.lastError;
      if (lastError) {
        reject(friendlyError(lastError.message ?? ""));
        return;
      }
      // Chrome also yields an empty responseUrl when the window is dismissed
      // without an error being set.
      if (!responseUrl) {
        reject(new AuthError("Sign-in was cancelled.", 0, "oauth_cancelled"));
        return;
      }
      resolve(responseUrl);
    });
  });
}

export async function runExtensionOAuth(
  authClient: AuthClient,
  provider: OAuthProvider,
): Promise<Session> {
  const identity = readChrome()?.identity;
  if (!identity) {
    throw new AuthError(
      "Sign-in is unavailable: the extension is missing the identity permission.",
      0,
      "oauth_failed",
    );
  }

  const pkce = await generatePkce();
  const redirect = identity.getRedirectURL();
  const authorizeUrl = authClient.oauthAuthorizeUrl(provider, redirect, pkce.challenge);

  // launchWebAuthFlow has no abort API, so an explicit cancel races the flow
  // instead of aborting it. Chrome's window may linger until the user closes
  // it; the orphaned promise is ignored either way. This exists so the sign-in
  // controls re-enable immediately rather than staying disabled behind a window
  // the user has already given up on.
  const cancellation = new Promise<never>((_, reject) => {
    activeCancel = () => reject(new AuthError("Sign-in was cancelled.", 0, "oauth_cancelled"));
  });

  let responseUrl: string;
  try {
    responseUrl = await Promise.race([launchWebAuthFlow(identity, authorizeUrl), cancellation]);
  } finally {
    activeCancel = null;
  }

  const params = new URL(responseUrl).searchParams;
  const failure = params.get("error");
  if (failure) throw friendlyError(params.get("error_description") || failure);

  const code = params.get("code");
  if (!code) throw new AuthError("OAuth sign-in failed.", 0, "oauth_failed");

  return authClient.exchangeOAuthCode(code, pkce.verifier);
}

/**
 * Abort an in-flight extension OAuth attempt so the caller's promise rejects
 * with `oauth_cancelled` and the UI can recover. No-op when nothing is pending.
 */
export function cancelExtensionOAuth(): void {
  activeCancel?.();
}
