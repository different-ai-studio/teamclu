/**
 * Cross-window "is this window busy" mirror for the auto-restart update mode.
 *
 * `UpdateDialogContainer` mounts at the app root, so it runs once per open
 * window — but streaming/terminal state lives in per-renderer Zustand stores
 * (each Tauri window is its own webview), invisible across windows. Only the
 * `"main"` window ever decides to restart (see `use-auto-restart.ts`), so
 * every other window broadcasts its own local busy signal here for `main` to
 * fold in before it acts. Modeled on the same `BroadcastChannel` pattern
 * `lib/auth/session-store.ts` uses for cross-tab session mirroring —
 * eventual-consistency, no leader election, because only the reader (`main`)
 * treats this as authoritative.
 */

const CHANNEL_NAME = "teamclu.window-activity";
/** An entry older than this is treated as a closed/gone window, not "busy". */
const STALE_MS = 30_000;

interface ActivityMessage {
  windowLabel: string;
  busy: boolean;
  at: number;
}

let channel: BroadcastChannel | null = null;
let channelInitTried = false;
const remoteActivity = new Map<string, ActivityMessage>();

function ensureChannel(): BroadcastChannel | null {
  if (channel || channelInitTried) return channel;
  channelInitTried = true;
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (ev: MessageEvent<ActivityMessage>) => {
      const data = ev.data;
      if (!data?.windowLabel) return;
      remoteActivity.set(data.windowLabel, data);
    };
  } catch {
    channel = null;
  }
  return channel;
}

/** Call periodically (and on change) from every window, including `main`. */
export function publishWindowActivity(windowLabel: string, busy: boolean): void {
  const ch = ensureChannel();
  const msg: ActivityMessage = { windowLabel, busy, at: Date.now() };
  // Seed our own entry directly — a BroadcastChannel does not deliver to its
  // own sender, and `main` needs its own state in the same map it reads.
  remoteActivity.set(windowLabel, msg);
  if (!ch) return;
  try {
    ch.postMessage(msg);
  } catch {
    // ignore
  }
}

/** True if some *other* window last reported busy within the freshness window. */
export function isAnyOtherWindowBusy(selfWindowLabel: string): boolean {
  const now = Date.now();
  for (const [label, msg] of remoteActivity) {
    if (label === selfWindowLabel) continue;
    if (now - msg.at > STALE_MS) continue;
    if (msg.busy) return true;
  }
  return false;
}
