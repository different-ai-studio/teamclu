import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getPermissionPolicy } from "@/lib/permission-policy";
import { isTauri } from "@/lib/utils";
import { appStoragePrefix } from "@/lib/build-config";
import { useSessionSelectionStore } from "@/stores/session-selection-store";

// --- Types ---

/** OS banner types still exposed in settings; only action_required is sent today. */
type NotificationType = "action_required" | "task_completed" | "info";

type NotificationSendResult = "sent" | "skipped";

type NotificationLevel = "all" | "important" | "mute";

export const NOTIFICATION_LEVEL_KEY = `${appStoragePrefix}-notification-level`;
const DEFAULT_LEVEL: NotificationLevel = "important";
const DOCK_ATTENTION_THROTTLE_MS = 5000;
const OS_BODY_MAX = 80;
const DIAG = "[notify-diag]";

/** Which notification types are allowed at each level */
const LEVEL_ALLOWS: Record<NotificationLevel, Set<NotificationType>> = {
  all: new Set(["action_required", "task_completed", "info"]),
  important: new Set(["action_required", "task_completed"]),
  mute: new Set(),
};

const notificationClickHandlers = new Map<number, () => void>();
let actionListenerReady = false;

function diag(event: string, detail?: Record<string, unknown>): void {
  if (detail) {
    console.info(DIAG, event, detail);
    return;
  }
  console.info(DIAG, event);
}

async function ensureNotificationActionListener(): Promise<void> {
  if (actionListenerReady || !isTauri()) return;
  actionListenerReady = true;
  try {
    await onAction((notification) => {
      diag("os:action-click", { id: notification.id ?? null });
      const id = notification.id;
      if (id == null) return;
      const handler = notificationClickHandlers.get(id);
      if (!handler) return;
      notificationClickHandlers.delete(id);
      try {
        handler();
      } catch (err) {
        console.warn(DIAG, "os:action-handler-failed", err);
      }
    });
    diag("os:action-listener-ready");
  } catch (err) {
    actionListenerReady = false;
    console.warn(DIAG, "os:action-listener-failed", err);
  }
}

function nextNotificationId(): number {
  return ((Date.now() & 0x7fffffff) ^ Math.floor(Math.random() * 0x7fffffff)) | 0;
}

function truncateBody(body: string, max = OS_BODY_MAX): string {
  if (!body) return "";
  return body.length <= max ? body : `${body.slice(0, max - 1)}…`;
}

// --- NotificationService ---

class NotificationService {
  /** Global throttle for macOS Dock bounce (inbox pings). */
  private lastDockAttentionAt = 0;

  /** Read the user's notification level from localStorage */
  getLevel(): NotificationLevel {
    try {
      const stored = localStorage.getItem(NOTIFICATION_LEVEL_KEY);
      if (stored === "all" || stored === "important" || stored === "mute") {
        return stored;
      }
    } catch {
      // localStorage unavailable
    }
    return DEFAULT_LEVEL;
  }

  /** Persist notification level to localStorage */
  setLevel(level: NotificationLevel): void {
    try {
      localStorage.setItem(NOTIFICATION_LEVEL_KEY, level);
    } catch {
      // localStorage unavailable
    }
  }

  /**
   * Send a desktop OS banner (permission prompts, etc.).
   * Inbox message pings use Dock bounce in Rust — see mqtt/dock_attention.rs.
   *
   * Returns `sent` only when a banner was actually shown; `skipped` otherwise
   * (suppress, level filter, permission denied, etc.).
   */
  async send(
    type: NotificationType,
    title: string,
    body: string,
    sessionId: string,
    onClick?: () => void,
  ): Promise<NotificationSendResult> {
    const activeSessionId = useSessionSelectionStore.getState().activeSessionId;
    const focused = await this.isWindowFocused();
    const visibility =
      typeof document !== "undefined" ? document.visibilityState : "unknown";

    diag("send:start", {
      type,
      sessionId,
      activeSessionId,
      focused,
      visibility,
      level: this.getLevel(),
      isTauri: isTauri(),
      title,
    });

    const suppress = await this.shouldSuppressBanner(type, sessionId);
    if (suppress) {
      diag("send:skipped", {
        reason: "suppress_banner",
        type,
        sessionId,
        activeSessionId,
        focused,
        visibility,
      });
      return "skipped";
    }

    const level = this.getLevel();
    if (!LEVEL_ALLOWS[level].has(type)) {
      diag("send:skipped", { reason: "level_filter", type, level });
      return "skipped";
    }

    try {
      let granted = await isPermissionGranted();
      diag("send:permission-check", { granted });
      if (!granted) {
        const policy = getPermissionPolicy();
        if (policy === "bypass" || policy === "batch") {
          diag("send:skipped", { reason: "permission_policy", policy });
          return "skipped";
        }
        const permission = await requestPermission();
        granted = permission === "granted";
        diag("send:permission-requested", { permission, granted });
      }
      if (!granted) {
        diag("send:skipped", { reason: "os_permission_denied" });
        return "skipped";
      }
    } catch (err) {
      console.warn(DIAG, "send:permission-check-failed", err);
      return "skipped";
    }

    const truncatedBody = truncateBody(body);

    if (isTauri()) {
      try {
        await ensureNotificationActionListener();
        const id = nextNotificationId();
        if (onClick) {
          notificationClickHandlers.set(id, onClick);
        }
        diag("send:tauri-sendNotification", { id, title, body: truncatedBody });
        sendNotification({
          id,
          title,
          body: truncatedBody || undefined,
          autoCancel: true,
        });
        diag("send:tauri-sendNotification-ok", { id });
      } catch (err) {
        notificationClickHandlers.clear();
        console.warn(DIAG, "send:tauri-sendNotification-failed", err);
        return "skipped";
      }
      return "sent";
    }

    try {
      diag("send:web-notification", { title, body: truncatedBody });
      const notification = new Notification(title, {
        body: truncatedBody || undefined,
        silent: false,
      });

      if (onClick) {
        notification.onclick = () => {
          try {
            onClick();
          } catch (err) {
            console.warn(DIAG, "send:web-click-failed", err);
          }
        };
      }
      diag("send:web-notification-ok");
      return "sent";
    } catch (err) {
      console.warn(DIAG, "send:web-notification-failed", err);
      return "skipped";
    }
  }

  /** Bounce the macOS Dock icon once when the app is in the background. */
  async requestDockAttention(): Promise<void> {
    if (!isTauri()) return;
    if (await this.isWindowFocused()) return;

    const now = Date.now();
    if (now - this.lastDockAttentionAt < DOCK_ATTENTION_THROTTLE_MS) {
      return;
    }
    this.lastDockAttentionAt = now;

    try {
      const { getCurrentWindow, UserAttentionType } = await import(
        "@tauri-apps/api/window"
      );
      await getCurrentWindow().requestUserAttention(
        UserAttentionType.Informational,
      );
    } catch {
      // Tauri window API unavailable
    }
  }

  /**
   * Permission banners suppress only when the user is already on that session.
   * Other types suppress whenever the window is focused.
   */
  private async shouldSuppressBanner(
    type: NotificationType,
    sessionId: string,
  ): Promise<boolean> {
    const focused = await this.isWindowFocused();
    if (!focused) return false;
    if (type === "action_required") {
      return useSessionSelectionStore.getState().activeSessionId === sessionId;
    }
    return true;
  }

  private async isWindowFocused(): Promise<boolean> {
    if (!isTauri()) {
      return typeof document !== "undefined" && document.visibilityState === "visible";
    }
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      return await getCurrentWindow().isFocused();
    } catch (err) {
      console.warn(DIAG, "focus:isFocused-failed", err);
      return false;
    }
  }

  /** Test hook — clears dock-attention throttle. */
  resetDockAttentionForTests(): void {
    this.lastDockAttentionAt = 0;
  }
}

/** Singleton instance */
export const notificationService = new NotificationService();
