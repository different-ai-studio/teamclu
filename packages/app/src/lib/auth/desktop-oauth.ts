// Desktop (Tauri) OAuth orchestration: loopback listener + system browser +
// PKCE exchange. Reuses the FC PKCE endpoints via the AuthClient.

import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import type { AuthClient } from "@/lib/auth/auth-client";
import { generatePkce } from "@/lib/auth/oauth-pkce";
import { AuthError, type Session } from "@/lib/auth/types";

export type OAuthProvider = "google" | "wechat";

function friendlyError(raw: unknown): AuthError {
  const text = typeof raw === "string" ? raw : raw instanceof Error ? raw.message : String(raw);
  if (text.includes("oauth_cancelled") || text.includes("oauth_timeout")) {
    return new AuthError("Sign-in was cancelled.", 0, "oauth_cancelled");
  }
  return new AuthError(text || "OAuth sign-in failed.", 0, "oauth_failed");
}

export async function runDesktopOAuth(
  authClient: AuthClient,
  provider: OAuthProvider,
): Promise<Session> {
  const pkce = await generatePkce();
  const { port } = await invoke<{ port: number }>("oauth_loopback_start");
  const redirect = `http://127.0.0.1:${port}/callback`;
  const authorizeUrl = authClient.oauthAuthorizeUrl(provider, redirect, pkce.challenge);
  await shellOpen(authorizeUrl);
  let code: string;
  try {
    ({ code } = await invoke<{ code: string }>("oauth_loopback_await"));
  } catch (err) {
    throw friendlyError(err);
  }
  return authClient.exchangeOAuthCode(code, pkce.verifier);
}

/**
 * Abort an in-flight desktop OAuth attempt. The blocked `oauth_loopback_await`
 * resolves immediately as `oauth_cancelled`, so the caller's `runDesktopOAuth`
 * promise rejects and the UI can re-enable its sign-in controls without waiting
 * out the long loopback timeout. No-op when nothing is pending.
 */
export async function cancelDesktopOAuth(): Promise<void> {
  try {
    await invoke("oauth_loopback_cancel");
  } catch {
    // best-effort: a missing/absent listener is fine, nothing to cancel.
  }
}
