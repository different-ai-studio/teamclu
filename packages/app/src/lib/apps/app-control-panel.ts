/**
 * Resolve which app the control panel should show: the app the open session
 * belongs to, and nothing else.
 *
 * The session's own `app_id` (server column, carried on the session list row)
 * decides. `appIdBySessionId` covers a session opened or created from the apps
 * section before the list row carrying that column has landed.
 *
 * Never the app selected in the sidebar: that selection outlives leaving the
 * apps section, and honouring it hung the last app's panel over every ordinary
 * chat opened afterwards. Never inferred from the workspace path either.
 */
export function resolveControlPanelAppId(args: {
  activeSessionId: string | null;
  sessionAppId: string | null | undefined;
  appIdBySessionId: Record<string, string>;
}): string | null {
  if (!args.activeSessionId) return null;
  return args.sessionAppId || args.appIdBySessionId[args.activeSessionId] || null;
}
