import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { withAsync } from '@/lib/store-utils'
import { useWorkspaceStore } from '@/stores/workspace'
import { useCurrentTeamStore } from '@/stores/current-team'
import { getFreshAccessToken } from '@/lib/auth/session-store'
import { getEffectiveServerConfigSync } from '@/lib/server-config'

/** Environment variable entry (key + description, no secret value). */
export interface EnvVarEntry {
  key: string
  description?: string
  /**
   * `system`        — locally seeded by Rust on every launch (e.g. `tc_api_key`).
   * `system-shared` — registered by Rust on every launch but the value lives in
   *                   team `_secrets/`. Surfaced even when unset so the user is
   *                   reminded to fill it in.
   */
  category?: 'system' | 'system-shared' | null
}

/** Team secret metadata (no plaintext value). */
export interface TeamEnvListing {
  keyId: string
  description: string
  category: string
  createdBy: string
  updatedBy: string
  updatedAt: string
  /**
   * `false` when the secret file exists (so the key is known) but the local
   * team secret is missing or wrong and it could not be decrypted. The UI shows
   * these keys with a "not decrypted" warning instead of hiding them.
   */
  decrypted?: boolean
  /**
   * Only meaningful when `decrypted === false`. `true`: a local team secret was
   * present but this file failed to decrypt (wrong / rotated key). `false`: no
   * local secret at all (missing).
   */
  keyMismatch?: boolean
}

/** Unified catalog returned by `env_catalog_list`. */
export interface EnvCatalog {
  personal: EnvVarEntry[]
  team: TeamEnvListing[]
}

export type EnvScope = 'personal' | 'team'

interface EnvVarsState {
  envVars: EnvVarEntry[]
  teamSecrets: TeamEnvListing[]
  isLoading: boolean
  error: string | null
  hasChanges: boolean

  loadEnvCatalog: () => Promise<void>
  setCatalogEntry: (
    scope: EnvScope,
    key: string,
    value: string,
    options?: { description?: string; category?: string; nodeId?: string },
  ) => Promise<void>
  deleteCatalogEntry: (
    scope: EnvScope,
    key: string,
    options?: { nodeId?: string; role?: string },
  ) => Promise<void>
  getEnvVarValue: (key: string) => Promise<string>
  clearError: () => void
  setHasChanges: (hasChanges: boolean) => void
}

/**
 * The workspace to hand the env commands — or null, which is a valid answer.
 *
 * Neither half of this catalog is per-project: personal vars live in the
 * home-scoped secret store, team vars come from the Cloud API. The Rust side
 * resolves the daemon's own default workspace when it gets none. This used to
 * throw "No workspace selected", which killed the entire Env panel before a
 * folder was opened — and `loadSection('env')` swallows that throw, so the
 * section showed a stale count and no error at all.
 */
function currentWorkspacePath(): string | null {
  return useWorkspaceStore.getState().workspacePath
}

async function fetchEnvCatalog(): Promise<EnvCatalog> {
  return invoke<EnvCatalog>('env_catalog_list', {
    teamId: useCurrentTeamStore.getState().team?.id,
    // Team values are fetched from the Cloud API and decrypted locally, so the
    // read needs a bearer too — without it only legacy on-disk files show up.
    accessToken: await getFreshAccessToken().catch(() => null),
    // Must travel with the token: runtime server selection lives here, and a
    // token minted by the selected server is a 401 anywhere else.
    cloudApiUrl: getEffectiveServerConfigSync().cloudApiUrl,
    workspacePath: currentWorkspacePath(),
  })
}

export const useEnvVarsStore = create<EnvVarsState>((set) => ({
  envVars: [],
  teamSecrets: [],
  isLoading: false,
  error: null,
  hasChanges: false,

  loadEnvCatalog: async () => {
    await withAsync(set, async () => {
      const catalog = await fetchEnvCatalog()
      set({ envVars: catalog.personal, teamSecrets: catalog.team })
    })
  },

  setCatalogEntry: async (scope, key, value, options) => {
    await withAsync(set, async () => {
      await invoke('env_catalog_set', {
        scope,
        key,
        value,
        description: options?.description,
        category: options?.category,
        nodeId: options?.nodeId,
        teamId: useCurrentTeamStore.getState().team?.id,
        // Team-scope values are stored in the Cloud API, so the Rust side needs
        // a bearer. Personal values never leave the machine and ignore it.
        accessToken: scope === 'team' ? await getFreshAccessToken().catch(() => null) : null,
        cloudApiUrl: getEffectiveServerConfigSync().cloudApiUrl,
        workspacePath: currentWorkspacePath(),
      })
      const catalog = await fetchEnvCatalog()
      set({ envVars: catalog.personal, teamSecrets: catalog.team, hasChanges: true })
    }, { rethrow: true })
  },

  deleteCatalogEntry: async (scope, key, options) => {
    await withAsync(set, async () => {
      await invoke('env_catalog_delete', {
        scope,
        key,
        nodeId: options?.nodeId,
        role: options?.role,
        teamId: useCurrentTeamStore.getState().team?.id,
        accessToken: scope === 'team' ? await getFreshAccessToken().catch(() => null) : null,
        cloudApiUrl: getEffectiveServerConfigSync().cloudApiUrl,
        workspacePath: currentWorkspacePath(),
      })
      const catalog = await fetchEnvCatalog()
      set({ envVars: catalog.personal, teamSecrets: catalog.team, hasChanges: true })
    }, { rethrow: true })
  },

  getEnvVarValue: async (key: string) => {
    return invoke<string>('env_var_get', {
      key,
      workspacePath: currentWorkspacePath(),
    })
  },

  clearError: () => set({ error: null }),

  setHasChanges: (hasChanges: boolean) => set({ hasChanges }),
}))
