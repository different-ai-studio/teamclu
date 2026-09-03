/**
 * Resolve which app the control panel should show.
 *
 * Design §2.4: selected app in column 1 ?? active session's linked app.
 * Never infer from workspace path.
 */
export function resolveControlPanelAppId(args: {
  selectedAppId: string | null;
  activeSessionId: string | null;
  appIdBySessionId: Record<string, string>;
}): string | null {
  if (args.selectedAppId) return args.selectedAppId;
  if (!args.activeSessionId) return null;
  return args.appIdBySessionId[args.activeSessionId] ?? null;
}
