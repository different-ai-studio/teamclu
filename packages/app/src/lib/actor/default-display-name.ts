import { isTauri } from "@/lib/utils";

/**
 * Best-effort real name for a brand-new member, used to seed their team
 * display name instead of the legacy "You".
 *
 * Resolution order:
 *   1. OS account real name (desktop only, via the `os_full_name` Tauri command
 *      — macOS full name / Windows display name / Linux GECOS, all platforms).
 *   2. The account email's local part (e.g. `jin.liang` from `jin.liang@x.com`).
 *   3. `undefined` — the server then synthesizes a stable "Adjective Animal"
 *      handle, so we deliberately send nothing rather than a placeholder.
 *
 * Never throws: any failure falls through to the next source.
 */
export async function resolveDefaultDisplayName(
  email?: string | null,
): Promise<string | undefined> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const osName = (await invoke<string>("os_full_name"))?.trim();
      if (osName) return osName;
    } catch {
      // Non-desktop or command unavailable — fall through to email.
    }
  }

  const local = email?.split("@")[0]?.trim();
  if (local) return local;

  return undefined;
}
