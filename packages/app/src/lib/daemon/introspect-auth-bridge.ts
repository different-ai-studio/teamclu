/**
 * Push the signed-in user's Cloud API credentials into the desktop Rust
 * introspect auth bridge so MCP tools (e.g. archive_session) can call /v1.
 *
 * No-op outside Tauri. Failures are swallowed — archive will surface a clear
 * "not signed in" error if the bridge is empty.
 */

import { invoke } from "@tauri-apps/api/core";
import { getFreshAccessToken } from "@/lib/auth/session-store";
import { getEffectiveServerConfigSync } from "@/lib/config/server-config";
import { isTauri } from "@/lib/utils";

export async function syncIntrospectAuthBridge(
  session: { accessToken?: string | null } | null | undefined,
): Promise<void> {
  if (!isTauri()) return;
  try {
    if (!session?.accessToken) {
      await invoke("clear_introspect_auth");
      return;
    }
    const accessToken = await getFreshAccessToken().catch(() => session.accessToken);
    if (!accessToken) {
      await invoke("clear_introspect_auth");
      return;
    }
    const cloudApiUrl = getEffectiveServerConfigSync().cloudApiUrl;
    await invoke("set_introspect_auth", {
      accessToken,
      cloudApiUrl: cloudApiUrl ?? null,
    });
  } catch (error) {
    console.warn("[introspect-auth] sync failed:", error);
  }
}

export async function clearIntrospectAuthBridge(): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("clear_introspect_auth");
  } catch (error) {
    console.warn("[introspect-auth] clear failed:", error);
  }
}
