import { getCurrentDaemonWorkspaceAgent, listDaemonWorkspaces } from '@/lib/daemon/daemon-workspaces'
import { isDaemonHttpAvailable, getDaemonModelCatalog, encodeWorkspaceId } from '@/lib/daemon/daemon-local-client'
import {
  listLocalDaemonWorkspaces,
  defaultLocalDaemonWorkspacePath,
  resolveDaemonWorkspacePath,
} from '@/lib/cron/cron-workspace-models'
import { workspacePathsMatch } from '@/stores/session-utils'
import { isTauri } from '@/lib/utils'

/**
 * "What can this device run?" — the model list behind device-wide defaults.
 *
 * # Why this is not `loadCronDialogModels`
 *
 * That loader answers a narrower question: which models can *this job's*
 * runtime offer. To do it, it picks ONE backend slice out of the catalog —
 * preferring the live runtime's `agentType`, falling back to
 * `automation_default_backend`, and finally to the literal string
 * `'opencode'`. On a device whose catalog only publishes a `pi` slice, any of
 * those falling to `'opencode'` yields "no configured models" while twenty pi
 * models sit in the same response — the picker is empty and the reason is
 * invisible.
 *
 * A device-wide default has no job and no runtime to key off, so it should not
 * be asking that question at all. This unions every slice the catalog
 * publishes and tags each option with the backend it came from, which is what
 * the cron payload needs anyway (`payload.backend`). The failure mode
 * disappears with the choice: an empty list here means the catalog is genuinely
 * empty.
 */

export interface DeviceModelOption {
  /** ACP model ref, stored verbatim (`provider/model`). */
  id: string
  displayName: string
  /** Provider segment, for the picker's two-level grouping. */
  providerName?: string
  /** `"opencode" | "pi" | "cursor" | "claude"` — the catalog slice it came from. */
  backend: string
}

/** Why the list is empty, so the caller can say so in its own words. */
export type DeviceModelsReason =
  | 'ok'
  | 'no-default-workspace'
  | 'daemon-unavailable'
  | 'no-models'
  | 'failed'

interface DeviceModelsResult {
  options: DeviceModelOption[]
  reason: DeviceModelsReason
  /** The catalog's own default backend, when it names one. */
  defaultBackend: string | null
}

const EMPTY: DeviceModelsResult = { options: [], reason: 'failed', defaultBackend: null }

/**
 * The daemon's default workspace path, which is where a gateway session and a
 * global cron job both run. Local registry first (it carries `isDefault`), then
 * the cloud agent's `defaultWorkspaceId` for a daemon whose local list is empty.
 */
async function defaultWorkspacePath(teamId: string | null): Promise<string | null> {
  const local = await listLocalDaemonWorkspaces()
  const fromLocal = defaultLocalDaemonWorkspacePath(local)
  if (fromLocal) return fromLocal
  if (!teamId) return null

  const agent = await getCurrentDaemonWorkspaceAgent(teamId).catch(() => null)
  if (!agent) return null
  const rows = await listDaemonWorkspaces(teamId, agent.id).catch(() => [])
  const remote = rows.find((w) => w.id === agent.defaultWorkspaceId)?.path || null
  if (!remote) return null
  // Prefer the locally-registered spelling of the same directory when we have it.
  return local.find((w) => workspacePathsMatch(w.path, remote))?.path ?? remote
}

function providerOf(ref: string): string | undefined {
  const slash = ref.indexOf('/')
  return slash > 0 ? ref.slice(0, slash) : undefined
}

export async function loadDeviceModelOptions(teamId: string | null): Promise<DeviceModelsResult> {
  let path: string | null
  try {
    path = await defaultWorkspacePath(teamId)
  } catch {
    return EMPTY
  }
  if (!path) return { options: [], reason: 'no-default-workspace', defaultBackend: null }

  const resolved = (await resolveDaemonWorkspacePath(teamId, path).catch(() => null)) ?? path

  if (isTauri() && !(await isDaemonHttpAvailable().catch(() => false))) {
    return { options: [], reason: 'daemon-unavailable', defaultBackend: null }
  }

  let catalog
  try {
    catalog = await getDaemonModelCatalog(encodeWorkspaceId(resolved))
  } catch {
    return EMPTY
  }
  if (catalog === null) return EMPTY

  const seen = new Set<string>()
  const options: DeviceModelOption[] = []
  for (const slice of catalog.backends ?? []) {
    for (const model of slice.models ?? []) {
      const id = model.ref?.trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      options.push({
        id,
        displayName: model.display_name?.trim() || id,
        providerName: providerOf(id),
        backend: slice.backend,
      })
    }
  }

  // An empty catalog carrying `probe_error` is "could not ask", which is not
  // the same as "nothing configured" — telling the user to add a provider when
  // the probe simply failed sends them to fix something that is not broken.
  const reason: DeviceModelsReason =
    options.length > 0 ? 'ok' : catalog.probe_error ? 'failed' : 'no-models'

  return {
    options,
    reason,
    defaultBackend: catalog.automation_default_backend ?? null,
  }
}
