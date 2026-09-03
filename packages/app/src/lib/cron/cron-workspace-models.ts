import {
  listLocalDaemonWorkspaces,
  defaultLocalDaemonWorkspacePath,
  type LocalDaemonWorkspace,
} from '@/lib/daemon/local-daemon-workspaces'
import {
  getCurrentDaemonWorkspaceAgent,
  listDaemonWorkspaces,
} from '@/lib/daemon/daemon-workspaces'
import {
  isDaemonHttpAvailable,
  getDaemonModelCatalog,
  encodeWorkspaceId,
} from '@/lib/daemon/daemon-local-client'
import { resolveAgentAvailableModels } from '@/lib/agent/agent-available-models'
import { AgentType } from '@/lib/proto/amux_pb'
import { useRuntimeStateStore, type RuntimeStateEntry } from '@/stores/runtime-state-store'
import { workspacePathsMatch } from '@/stores/session-utils'
import type { CronScope } from '@/stores/cron'
import { isTauri } from '@/lib/utils'

/** Map daemon HTTP workspace path to the canonical path registered on this daemon. */
export async function resolveDaemonWorkspacePath(
  teamId: string | null,
  localPath: string | null | undefined,
): Promise<string | null> {
  const trimmed = localPath?.trim()
  if (!trimmed) return null
  if (!teamId) return trimmed

  const rows = await listDaemonWorkspaces(teamId).catch(() => [])
  for (const row of rows) {
    const daemonPath = row.path?.trim()
    if (!daemonPath) continue
    if (workspacePathsMatch(trimmed, daemonPath)) return daemonPath
  }
  return trimmed
}

// Re-exported so the cron surfaces keep their existing import site.
export {
  listLocalDaemonWorkspaces,
  defaultLocalDaemonWorkspacePath,
  type LocalDaemonWorkspace,
}

async function waitForDaemonHttpReady(timeoutMs = 8000): Promise<boolean> {
  if (!isTauri()) return false
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isDaemonHttpAvailable()) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

/** A single selectable model in the cron dialog, carrying its backend so the
 *  scheduler can pin the job to the right agent runtime. */
interface CronModelOption {
  /** ACP model id (often `provider/model`) — stored verbatim as `payload.model`. */
  ref: string
  name: string
  /** Daemon-advertised provider label, used to group the picker like chat does. */
  providerName?: string
}

/** Models for one agent backend. Cron UI renders a flat list like chat. */
export interface CronModelGroup {
  /** "opencode" | "claude" | "pi" | "cursor" — stored as `payload.backend`. */
  backend: string
  label: string
  models: CronModelOption[]
}

function cronBackendFromAgentType(agentType: AgentType): string {
  switch (agentType) {
    case AgentType.CLAUDE_CODE:
      return 'claude'
    case AgentType.PI:
      return 'pi'
    case AgentType.CURSOR:
      return 'cursor'
    case AgentType.OPENCODE:
    default:
      return 'opencode'
  }
}

function uniqueRuntimeEntries(): RuntimeStateEntry[] {
  const seen = new Set<RuntimeStateEntry>()
  for (const entry of Object.values(useRuntimeStateStore.getState().byRuntimeId)) {
    seen.add(entry)
  }
  return [...seen]
}

/** Newest live attachment whose worktree matches the target workspace path. */
export function findRuntimeForWorkspace(workspacePath: string): RuntimeStateEntry | undefined {
  let best: RuntimeStateEntry | undefined
  for (const entry of uniqueRuntimeEntries()) {
    const worktree = entry.info.worktree?.trim()
    if (!worktree || !workspacePathsMatch(workspacePath, worktree)) continue
    if (!best || entry.lastUpdated >= best.lastUpdated) best = entry
  }
  return best
}

function groupFromAcpModels(
  models: Array<{ id: string; displayName: string; providerName?: string }>,
  backend: string,
): CronModelGroup[] {
  if (models.length === 0) return []
  return [
    {
      backend,
      label: '',
      models: models.map((m) => ({
        ref: m.id,
        name: m.displayName?.trim() || m.id,
        providerName: m.providerName?.trim() || undefined,
      })),
    },
  ]
}

/** Models from the live runtime retain (`RuntimeInfo.availableModels`). Chat's
 * AgentSelectorDock also supplements from the loopback catalog; cron stays
 * retain-only here and uses `modelsFromCatalogFallback` when retain is empty. */
export function modelsFromLiveRuntime(workspacePath: string): CronModelGroup[] {
  const runtime = findRuntimeForWorkspace(workspacePath)
  if (!runtime) return []
  const models = resolveAgentAvailableModels(runtime.info)
  return groupFromAcpModels(models, cronBackendFromAgentType(runtime.info.agentType))
}

/** When no live runtime advertises models, fall back to
 * `GET …/model-catalog` for the default (or preferred) backend. */
async function modelsFromCatalogFallback(
  workspacePath: string,
  preferBackend?: string | null,
): Promise<{
  groups: CronModelGroup[]
  automationDefaultBackend: string | null
} | null> {
  const catalog = await getDaemonModelCatalog(encodeWorkspaceId(workspacePath))
  if (catalog === null) return null

  const backendId = preferBackend ?? catalog.automation_default_backend ?? 'opencode'
  const slice = catalog.backends.find((b) => b.backend === backendId)
  if (!slice || slice.models.length === 0) {
    return { groups: [], automationDefaultBackend: catalog.automation_default_backend }
  }

  return {
    groups: [
      {
        backend: backendId,
        label: '',
        models: slice.models.map((m) => ({
          ref: m.ref,
          name: m.display_name,
        })),
      },
    ],
    automationDefaultBackend: catalog.automation_default_backend,
  }
}

type CronDialogModelLoadResult = {
  groups: CronModelGroup[]
  /** Backend the daemon picks when a job specifies none ("auto"); the dialog
   *  surfaces it as the default. `null` when no backend is configured. */
  automationDefaultBackend: string | null
  hint: string | null
}

/** Resolve target workspace path for cron scope and load model options. */
export async function loadCronDialogModels(args: {
  activeScope: CronScope
  teamId: string | null
  /** Workspace-scoped cron only — explicit daemon workspace path, not the UI session workspace. */
  selectedWorkspacePath: string | null
  localWorkspaces?: LocalDaemonWorkspace[]
  messages: {
    workspaceNoPath: string
    globalNoTeam: string
    globalNoDefault: string
    globalNoDefaultPath: string
    daemonUnavailable: string
    noConfiguredModels: string
    loadFailed: string
  }
}): Promise<CronDialogModelLoadResult> {
  let targetPath: string | null = null
  let hint: string | null = null

  if (args.activeScope === 'workspace') {
    if (!args.selectedWorkspacePath) {
      hint = args.messages.workspaceNoPath
    } else {
      targetPath = args.selectedWorkspacePath
    }
  } else {
    const localWorkspaces = args.localWorkspaces ?? await listLocalDaemonWorkspaces()
    targetPath = defaultLocalDaemonWorkspacePath(localWorkspaces)
    if (!targetPath && args.teamId) {
      const agent = await getCurrentDaemonWorkspaceAgent(args.teamId).catch(() => null)
      const workspaces = agent ? await listDaemonWorkspaces(args.teamId, agent.id).catch(() => []) : []
      const defaultWs = workspaces.find((w) => w.id === agent?.defaultWorkspaceId)
      targetPath = defaultWs?.path || null

      if (targetPath) {
        const resolved = localWorkspaces.find((w) => workspacePathsMatch(w.path, targetPath!))
        targetPath = resolved?.path || targetPath
      }
    }
    if (!targetPath) {
      hint = args.messages.globalNoDefault
    }
  }

  if (!targetPath) {
    return { groups: [], automationDefaultBackend: null, hint }
  }

  const resolvedPath = await resolveDaemonWorkspacePath(args.teamId, targetPath)
  if (!resolvedPath) {
    return { groups: [], automationDefaultBackend: null, hint: args.messages.loadFailed }
  }

  const liveGroups = modelsFromLiveRuntime(resolvedPath)
  if (liveGroups.length > 0) {
    return {
      groups: liveGroups,
      automationDefaultBackend: liveGroups[0]?.backend ?? null,
      hint: null,
    }
  }

  if (isTauri()) {
    const daemonReady = await waitForDaemonHttpReady()
    if (!daemonReady) {
      return { groups: [], automationDefaultBackend: null, hint: args.messages.daemonUnavailable }
    }
  }

  try {
    const runtime = findRuntimeForWorkspace(resolvedPath)
    const preferBackend = runtime
      ? cronBackendFromAgentType(runtime.info.agentType)
      : null
    const catalog = await modelsFromCatalogFallback(resolvedPath, preferBackend)
    if (catalog === null) {
      return { groups: [], automationDefaultBackend: null, hint: args.messages.loadFailed }
    }

    if (catalog.groups.length === 0) {
      return {
        groups: [],
        automationDefaultBackend: catalog.automationDefaultBackend,
        hint: args.messages.noConfiguredModels,
      }
    }
    return {
      groups: catalog.groups,
      automationDefaultBackend: catalog.automationDefaultBackend,
      hint: null,
    }
  } catch {
    return { groups: [], automationDefaultBackend: null, hint: args.messages.loadFailed }
  }
}
