import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  encodeWorkspaceId,
  getDaemonAllowlist,
  getDaemonToolPermissions,
  putDaemonAllowlist,
  putDaemonToolPermissions,
  type DaemonAllowlistRule,
} from "@/lib/daemon-local-client";
import { replyPermissionById } from "@/lib/teamclu/reply-acp-permission";
import { isTauri } from "@/lib/utils";
import { appDisplayName } from "@/lib/build-config";
import { notificationService } from "@/lib/notification-service";
import { shouldAutoAuthorize } from "@/lib/permission-policy";
import type { PermissionAskedEvent } from "./session-types";
import { effectiveWorkspacePath } from "@/lib/effective-workspace";
import type {
  PendingPermissionEntry,
  ToolCallPermission,
  SessionState,
} from "./session-types";
import {
  sessionLookupCache,
  getSessionById,
} from "./session-cache";
import {
  pendingPermissionBuffer,
  attachPermissionToToolCall,
} from "./session-internals";
import {
  resolveSessionActivityOwner,
} from "@/lib/session-list-activity";

/**
 * Cache of tool-level permission defaults from the daemon workspace-control API.
 * Maps permission name (e.g. "bash", "write") to its action ("allow" | "ask" | "deny").
 */
let _permConfigCache: Record<string, string> | null = null;
let _permConfigLoading = false;

async function loadPermissionConfig(): Promise<Record<string, string>> {
  if (_permConfigCache) return _permConfigCache;
  if (!isTauri()) return {};

  // Falls back to the daemon's default workspace: tool permissions are config
  // the daemon reads wherever it runs, and returning {} with no folder open
  // meant every "always allow" the user had set was invisible to this session.
  const workspacePath = await effectiveWorkspacePath();
  if (!workspacePath) return {};

  if (_permConfigLoading) return {};
  _permConfigLoading = true;

  try {
    const workspaceId = encodeWorkspaceId(workspacePath);
    const tools = await getDaemonToolPermissions(workspaceId);
    if (tools) {
      _permConfigCache = tools;
      return _permConfigCache;
    }
  } catch {
    // ignore read errors
  } finally {
    _permConfigLoading = false;
  }
  return {};
}

/**
 * In-memory set of permission types the user has clicked "Always Allow" for
 * during this app session. Prevents repeated dialogs for the same permission type.
 */
const _alwaysAllowedPermissions = new Set<string>();

/**
 * Write a permission as "allow" via the daemon so the agent runtime stops
 * asking for this permission type entirely.
 */
async function setPermissionAllowInConfig(permissionType: string): Promise<void> {
  if (!isTauri()) return;

  const workspacePath = await effectiveWorkspacePath();
  if (!workspacePath) return;

  if (_permConfigCache?.[permissionType] === "allow") return;

  try {
    const workspaceId = encodeWorkspaceId(workspacePath);
    await putDaemonToolPermissions(workspaceId, { [permissionType]: "allow" });
    _permConfigCache = { ...(_permConfigCache ?? {}), [permissionType]: "allow" };
    console.log("[Session] Set permission '%s' to 'allow' via daemon", permissionType);
  } catch (err) {
    console.error("[Session] Failed to update permission via daemon:", err);
  }
}

/** Pre-load the permission config cache. Call early so it's available synchronously later. */
export function loadPermissionConfigCache(): void {
  loadPermissionConfig().catch(() => { /* ignore */ });
}

/** Invalidate the permission config cache (call when config is saved). */
export function invalidatePermissionConfigCache(): void {
  _permConfigCache = null;
}

type SessionSet = (fn: ((state: SessionState) => Partial<SessionState>) | Partial<SessionState>) => void;
type SessionGet = () => SessionState;

/**
 * Persist an "always allow" rule via the daemon workspace-control API so it
 * survives restarts. Stored in `<workspace>/.teamclu/allowlist.json`.
 */
async function persistAllowlistRule(perm: PermissionAskedEvent): Promise<void> {
  if (!isTauri()) return;

  const workspacePath = await effectiveWorkspacePath();
  if (!workspacePath) return;

  const projectId = "global";

  const patterns: string[] = [];
  if (perm.always && perm.always.length > 0) {
    patterns.push(...perm.always);
  } else if (perm.patterns && perm.patterns.length > 0) {
    const firstToken = perm.patterns[0]?.split(" ")[0];
    if (firstToken) patterns.push(`${firstToken} *`);
  }

  if (patterns.length === 0) return;

  const workspaceId = encodeWorkspaceId(workspacePath);
  const existing = (await getDaemonAllowlist(workspaceId)) ?? [];

  const updated: DaemonAllowlistRule[] = [...existing];
  for (const pat of patterns) {
    const alreadyExists = updated.some(
      (r) =>
        r.project_id === projectId &&
        r.permission === perm.permission &&
        r.pattern === pat,
    );
    if (!alreadyExists) {
      updated.push({
        project_id: projectId,
        permission: perm.permission,
        pattern: pat,
        decision: "allow",
      });
    }
  }

  await putDaemonAllowlist(workspaceId, updated);

  console.log(
    "[Session] Persisted allowlist rules for project '%s': %s %s",
    projectId,
    perm.permission,
    patterns.join(", "),
  );
}

export function createPermissionActions(set: SessionSet, get: SessionGet) {
  type PermissionSessionClassification = {
    isChild: boolean;
    childSessionId: string | null;
    ownerSessionId: string | null;
  };
  const classifyPermissionSession = (sessionId: string | undefined | null) => {
    const { activeSessionId, sessions } = get();
    if (!sessionId || sessionId === activeSessionId) {
      return {
        isChild: false,
        childSessionId: null as string | null,
        ownerSessionId: sessionId || activeSessionId,
      };
    }

    const knownSession =
      sessions.find((session) => session.id === sessionId) ||
      getSessionById(sessionId);
    if (knownSession?.parentID) {
      const sessionsWithKnown = sessions.some((session) => session.id === knownSession.id)
        ? sessions
        : [...sessions, knownSession];
      const ownerSessionId = resolveSessionActivityOwner(
        sessionId,
        sessionsWithKnown,
        knownSession.parentID,
      );
      return { isChild: true, childSessionId: sessionId, ownerSessionId };
    }
    if (knownSession) {
      return { isChild: false, childSessionId: null as string | null, ownerSessionId: sessionId };
    }

    return { isChild: true, childSessionId: sessionId, ownerSessionId: null };
  };

  const resolvePermissionSession = async (
    sessionId: string | undefined | null,
  ): Promise<PermissionSessionClassification> => {
    return classifyPermissionSession(sessionId);
  };

  const queuePermission = (
    event: PermissionAskedEvent,
    classification: PermissionSessionClassification,
  ) => {
    if (!classification.ownerSessionId) return false;

    const entry: PendingPermissionEntry = {
      permission: event,
      childSessionId: classification.childSessionId,
      ownerSessionId: classification.ownerSessionId,
    };

    set((state) => ({
      pendingPermissions: [
        ...state.pendingPermissions.filter((e) => e.permission.id !== event.id),
        entry,
      ].slice(-20), // Safety cap
    }));

    if (event.tool?.callID && !classification.isChild) {
      const attached = attachPermissionToToolCall(event);
      if (!attached) {
        pendingPermissionBuffer.set(event.tool.callID, event);
      }
    }

    return true;
  };

  const sendPermissionNotification = (event: PermissionAskedEvent) => {
    const {
      sessions: currentSessions,
      setActiveSession: navigateToSession,
    } = get();
    const session = currentSessions.find((s) => s.id === event.sessionID);
    const sessionTitle = session?.title || "Session";
    const permissionType = event.permission || "unknown";

    notificationService.send(
      "action_required",
      `${appDisplayName} - Authorization required`,
      `${sessionTitle} \u2014 requesting ${permissionType} permission`,
      event.sessionID,
      async () => {
        try {
          await navigateToSession(event.sessionID);
          const appWindow = getCurrentWindow();
          await appWindow.setFocus();
          await appWindow.unminimize();
        } catch {
          // Ignore focus errors
        }
      },
    );
  };

  return {
    handlePermissionAsked: (event: PermissionAskedEvent) => {
      // Check permission policy -- auto-authorize if bypass or batch-done
      if (shouldAutoAuthorize()) {
        replyPermissionById(event.id, "always").catch((err: unknown) => {
          console.error("[Session] Failed to auto-reply permission:", err);
        });
        return;
      }

      // Check legacy permission config -- auto-authorize if set to "allow"
      if (event.permission && _permConfigCache?.[event.permission] === "allow") {
        replyPermissionById(event.id, "allow").catch((err: unknown) => {
          console.error("[Session] Failed to auto-reply permission from config:", err);
        });
        return;
      }

      // Check if this permission type was already "Always Allowed" during this session
      if (event.permission && _alwaysAllowedPermissions.has(event.permission)) {
        replyPermissionById(event.id, "always").catch((err: unknown) => {
          console.error("[Session] Failed to auto-reply always-allowed permission:", err);
        });
        return;
      }

      const { isChild, childSessionId, ownerSessionId } = classifyPermissionSession(event.sessionID);
      if (ownerSessionId) {
        if (queuePermission(event, { isChild, childSessionId, ownerSessionId })) {
          sendPermissionNotification(event);
        }
        return;
      }

      resolvePermissionSession(event.sessionID).then((resolved) => {
        if (queuePermission(event, resolved)) {
          sendPermissionNotification(event);
        }
      }).catch(() => {
        // Ignore stale permission events for sessions that no longer exist.
      });
    },

    replyPermission: async (
      permissionId: string,
      decision: "allow" | "deny" | "always",
    ) => {
      const decisionState: ToolCallPermission["decision"] =
        decision === "deny" ? "denied" : decision === "always" ? "allowlisted" : "approved";

      try {
        await replyPermissionById(permissionId, decision);

        // Persist "always" decisions to the agent runtime DB and cache in memory
        if (decision === "always") {
          const { activeSessionId } = get();
          const session = activeSessionId ? getSessionById(activeSessionId) : null;
          let permEvent: PermissionAskedEvent | null = null;

          if (session) {
            for (const m of session.messages) {
              const tc = m.toolCalls?.find((t) => t.permission?.id === permissionId);
              if (tc?.permission) {
                permEvent = {
                  id: tc.permission.id,
                  sessionID: activeSessionId!,
                  permission: tc.permission.permission,
                  patterns: tc.permission.patterns,
                  always: tc.permission.always,
                  metadata: tc.permission.metadata,
                };
                break;
              }
            }
          }
          if (!permEvent) {
            const entry = get().pendingPermissions.find((e) => e.permission.id === permissionId);
            if (entry) {
              permEvent = entry.permission;
            }
          }
          if (permEvent) {
            // Cache in memory so subsequent requests for same permission type are auto-approved
            if (permEvent.permission) {
              _alwaysAllowedPermissions.add(permEvent.permission);
              // Write to legacy config so the agent runtime stops asking
              setPermissionAllowInConfig(permEvent.permission).catch((err) => {
                console.error("[Session] Failed to set permission in legacy config:", err);
              });
            }
            persistAllowlistRule(permEvent).catch((err) => {
              console.error("[Session] Failed to persist allowlist rule to DB:", err);
            });
          }
        }

        // Update the tool call's permission.decision in place
        const { activeSessionId } = get();
        if (activeSessionId) {
          set((state) => {
            const session = getSessionById(activeSessionId);
            if (!session) return {};
            let found = false;
            const newMessages = session.messages.map((m) => {
              const tcIdx = m.toolCalls?.findIndex((tc) => tc.permission?.id === permissionId);
              if (tcIdx === undefined || tcIdx === -1) return m;
              found = true;
              const newToolCalls = [...(m.toolCalls || [])];
              newToolCalls[tcIdx] = {
                ...newToolCalls[tcIdx],
                permission: { ...newToolCalls[tcIdx].permission!, decision: decisionState },
              };
              return { ...m, toolCalls: newToolCalls };
            });
            if (!found) {
              if (state.pendingPermissions.some((e) => e.permission.id === permissionId)) {
                return {
                  pendingPermissions: state.pendingPermissions.filter(
                    (e) => e.permission.id !== permissionId,
                  ),
                };
              }
              return {};
            }
            const newSession = { ...session, messages: newMessages };
            sessionLookupCache.set(activeSessionId, newSession);
            return {
              sessions: state.sessions.map((s) =>
                s.id === activeSessionId ? newSession : s,
              ),
            };
          });
        }

        // Also remove from floating pending permissions if present
        set((state) => ({
          pendingPermissions: state.pendingPermissions.filter((e) => e.permission.id !== permissionId),
        }));
      } catch (error) {
        console.error("[Session] Failed to reply permission:", error);
        set({
          error:
            error instanceof Error
              ? error.message
              : "Failed to reply to permission",
        });
      }
    },

    pollPermissions: async () => {
      // OpenCode HTTP permission polling removed; v2 uses ACP stream events.
    },
  };
}
