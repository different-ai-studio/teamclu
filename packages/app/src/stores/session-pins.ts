import { appStoragePrefix } from "@/lib/config/build-config";

const STORAGE_KEY = `${appStoragePrefix}-pinned-sessions`;

type PinnedSessionStorage = Record<string, string[]>;

function parsePinnedSessionStorage(raw: string | null): PinnedSessionStorage | null {
  try {
    if (!raw) return {};

    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Backward compatibility with the legacy flat-array format.
      return { __legacy__: parsed.filter((item): item is string => typeof item === "string") };
    }
    if (!parsed || typeof parsed !== "object") return {};

    const entries = Object.entries(parsed as Record<string, unknown>);
    return Object.fromEntries(
      entries.map(([key, ids]) => [
        key,
        Array.isArray(ids) ? ids.filter((item): item is string => typeof item === "string") : [],
      ]),
    );
  } catch {
    return {};
  }
}

function normalizeTeamId(teamId: string | null | undefined): string | null {
  const trimmed = teamId?.trim();
  return trimmed ? trimmed : null;
}

/** Keys from the pre-team workspace-scoped pin format. */
function isLegacyWorkspaceKey(key: string, teamId: string): boolean {
  return key !== teamId && (key === "__legacy__" || key.includes("/"));
}

function migrateWorkspacePinsToTeam(storage: PinnedSessionStorage, teamId: string): string[] {
  const ids = new Set<string>();
  for (const [key, list] of Object.entries(storage)) {
    if (!isLegacyWorkspaceKey(key, teamId)) continue;
    for (const id of list) ids.add(id);
  }
  return [...ids];
}

function persistTeamPins(storage: PinnedSessionStorage, teamId: string, ids: string[]): void {
  if (ids.length > 0) {
    storage[teamId] = ids;
  } else {
    delete storage[teamId];
  }
  for (const key of Object.keys(storage)) {
    if (isLegacyWorkspaceKey(key, teamId)) delete storage[key];
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(storage));
}

/** Load pinned session ids for the active team (team-scoped, not workspace-scoped). */
export function loadPinnedSessionIds(teamId?: string | null): string[] {
  const storage = parsePinnedSessionStorage(localStorage.getItem(STORAGE_KEY));
  const teamKey = normalizeTeamId(teamId);

  if (!storage) return [];
  if (!teamKey) return storage.__legacy__ ?? [];

  const existing = storage[teamKey];
  if (existing && existing.length > 0) return existing;

  const migrated = migrateWorkspacePinsToTeam(storage, teamKey);
  if (migrated.length > 0) {
    try {
      persistTeamPins(storage, teamKey, migrated);
    } catch {
      // Ignore storage failures so session list still works in constrained envs.
    }
  }
  return migrated;
}

export function savePinnedSessionIds(
  teamId: string | null | undefined,
  ids: string[],
): void {
  try {
    const teamKey = normalizeTeamId(teamId);
    const storage = parsePinnedSessionStorage(localStorage.getItem(STORAGE_KEY)) ?? {};

    if (!teamKey) {
      storage.__legacy__ = ids;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(storage));
      return;
    }

    persistTeamPins(storage, teamKey, ids);
  } catch {
    // Ignore storage failures so session list still works in constrained envs.
  }
}
