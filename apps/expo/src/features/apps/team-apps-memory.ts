import type { TeamApp } from "./team-app-types";

/**
 * In-process memory of the rows the list last saw, so the detail screen can
 * paint the app it was opened with while it re-reads the freshest copy —
 * iOS hands the record to the detail view directly; expo-router passes only
 * the id. Not persisted: deploy state is exactly the field a stored row would
 * be wrong about.
 */
const rows = new Map<string, TeamApp>();

export function rememberTeamApps(apps: readonly TeamApp[]): void {
  for (const app of apps) rows.set(app.id, app);
}

export function recallTeamApp(appId: string): TeamApp | null {
  return rows.get(appId) ?? null;
}
