import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/utils";

/**
 * Why the app left a signed-in state.
 *
 * The webview console is not written to disk, so a sign-out nobody asked for
 * used to leave no trace: on 2026-09-17 a desktop build signed its user out
 * a minute after launch and the logs could not say which code path did it.
 * Every way out of a session names itself here, and the line lands in the
 * desktop log file next to the Rust side's.
 */
export type SignOutReason =
  /** The sidebar account menu. */
  | "user_menu"
  /** "Sign out and use another account" on the team bootstrap error screen. */
  | "bootstrap_error_screen"
  /** The same button on the no-team screen. */
  | "no_team_screen"
  /** The same button on the name-your-team screen. */
  | "name_team_screen"
  /** Settings → Diagnostics → sign in again. */
  | "diagnostics_relogin"
  /** Team bootstrap got a 401 and the token refresh after it failed too. */
  | "team_bootstrap_auth_rejected"
  /** The stored session was issued by a different backend than the one configured. */
  | "session_from_other_backend"
  /** The server refused the refresh token, so the local session was dropped. */
  | "refresh_rejected"
  | "unspecified";

/** `LogLevel.Info` in tauri-plugin-log. */
const LOG_LEVEL_INFO = 3;

/**
 * Record a sign-out. Never throws and never waits: it runs on paths that are
 * already tearing a session down. Pass ids and codes only — never a token.
 */
export function logSignOut(
  reason: SignOutReason,
  fields: Record<string, string | null | undefined> = {},
): void {
  const parts = [`reason=${reason}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value) parts.push(`${key}=${JSON.stringify(value)}`);
  }
  const message = `[auth] sign-out ${parts.join(" ")}`;
  console.info(message);
  if (!isTauri()) return;
  try {
    void invoke("plugin:log|log", { level: LOG_LEVEL_INFO, message, location: "auth" }).catch(() => {});
  } catch {
    // The log is best-effort; a missing plugin must not block signing out.
  }
}
