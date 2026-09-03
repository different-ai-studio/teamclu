import { invoke } from "@tauri-apps/api/core";

/**
 * Credential fields that already hold a value, as dotted paths from the daemon
 * (`channels.wecom.bots[aibC…].secret`).
 *
 * The settings form reads credentials back empty on purpose — they live in the
 * team's encrypted store, not in `team.toml` — but an empty box is also exactly
 * what "never configured" looks like. Without this the only way to find out was
 * to retype the key, which is how a working credential gets replaced by a typo.
 *
 * Presence only. The values never leave the daemon.
 */
export async function loadChannelSecretKeys(): Promise<Set<string>> {
  try {
    const keys = await invoke<string[]>("list_channel_secret_keys");
    return new Set(keys);
  } catch {
    // A daemon that is down tells us nothing about what is stored; showing
    // "configured" on a guess would be worse than showing nothing.
    return new Set();
  }
}

/** The path the daemon uses for a per-bot credential on a multi-bot channel. */
export function botSecretPath(
  platform: string,
  botId: string,
  field: string,
): string {
  return `channels.${platform}.bots[${botId}].${field}`;
}

/** The path for a channel-level credential (`channels.feishu.app_secret`). */
export function channelSecretPath(platform: string, field: string): string {
  return `channels.${platform}.${field}`;
}
