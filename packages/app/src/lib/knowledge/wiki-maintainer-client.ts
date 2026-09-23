import { invoke } from '@tauri-apps/api/core'

import { loadDeviceModelOptions } from '@/lib/agent/device-default-models'
import { getBackend } from '@/lib/backend/provider'
import {
  fetchDocuments,
  listKnownDocuments,
} from '@/lib/daemon/daemon-local-client'
import { useTeamShareBrowserStore } from '@/stores/team-share-browser'
import { useWorkspaceStore } from '@/stores/workspace'
import type {
  WikiCompilerModel,
  WikiPrepareSummary,
  WikiPublishResult,
  WikiSourceDirectory,
} from '@/components/teamshare/WikiMaintainerRunSheet'
import type { WikiMaintainerStatus } from '@/lib/backend/cloud-api/wiki-maintainer'

interface DiscoverResponse {
  directories: WikiSourceDirectory[]
}

interface WikiCheckpointProgress {
  stage: 'checkpoint'
  expectedGeneration: number
  configVersion: number
  checkpointPath: string
  sha256: string
  size: number
  manifest: Record<string, unknown> & { teamId?: string; generation?: number }
}

function isUnderSelected(path: string, selected: string[]): boolean {
  return selected.some((prefix) => path.startsWith(prefix))
}

/** A Wiki source is one folder inside Documents. The Documents root is not a source. */
export function wikiSourceFolders(paths: string[]): string[] {
  return paths.filter((path) => {
    const match = /^documents\/([^/]+)\/$/.exec(path)
    return match !== null && match[1] !== '.' && match[1] !== '..'
  })
}

async function restoreCheckpointGeneration(
  teamId: string,
  generation: number,
  publishedCommit: string | null,
  source: 'latest' | 'exact',
): Promise<void> {
  const maintainer = getBackend().wikiMaintainer
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const remote =
        source === 'latest' && attempt === 0
          ? await maintainer.downloadLatestCheckpoint(teamId)
          : await maintainer.downloadCheckpoint(teamId, generation)
      if (remote.generation !== generation) {
        throw new Error('Wiki checkpoint download returned another generation.')
      }
      await invoke('kb_maintainer_restore_checkpoint', {
        request: {
          teamId,
          url: remote.url,
          sha256: remote.sha256,
          size: remote.size,
          publishedCommit,
        },
      })
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Wiki checkpoint download failed.')
}

async function restoreLatestCheckpoint(
  teamId: string,
  status: WikiMaintainerStatus,
): Promise<void> {
  if (!status.checkpoint) return
  const local = await invoke<{
    generation: number
    publishedCommit?: string | null
  }>(
    'kb_maintainer_local_checkpoint_status',
    { teamId },
  )
  if (
    (local?.generation ?? 0) === status.checkpoint.generation &&
    (local?.publishedCommit ?? null) === (status.publishedCommit ?? null)
  ) {
    return
  }
  try {
    await restoreCheckpointGeneration(
      teamId,
      status.checkpoint.generation,
      status.publishedCommit ?? null,
      'latest',
    )
  } catch (latestError) {
    if (status.checkpoint.parentGeneration < 1) throw latestError
    await restoreCheckpointGeneration(
      teamId,
      status.checkpoint.parentGeneration,
      null,
      'exact',
    )
  }
}

async function uploadCheckpointPackage(
  teamId: string,
  checkpoint: {
    expectedGeneration: number
    configVersion: number
    checkpointPath: string
    sha256: string
    size: number
    manifest: Record<string, unknown> & { generation?: number }
  },
): Promise<void> {
  const maintainer = getBackend().wikiMaintainer
  const prepared = await maintainer.prepareCheckpoint(teamId, {
    expectedGeneration: checkpoint.expectedGeneration,
    configVersion: checkpoint.configVersion,
    sha256: checkpoint.sha256,
    size: checkpoint.size,
  })
  if (prepared.requiresUpload) {
    if (!prepared.presignedPut) {
      throw new Error('Cloud API did not return a Wiki checkpoint upload URL.')
    }
    await invoke('kb_maintainer_upload_checkpoint', {
      request: {
        teamId,
        checkpointPath: checkpoint.checkpointPath,
        url: prepared.presignedPut,
        sha256: checkpoint.sha256,
        size: checkpoint.size,
      },
    })
  }
  await maintainer.completeCheckpoint(teamId, {
    expectedGeneration: checkpoint.expectedGeneration,
    configVersion: checkpoint.configVersion,
    sha256: checkpoint.sha256,
    size: checkpoint.size,
    objectKey: prepared.objectKey,
    manifest: checkpoint.manifest,
  })
}

export async function loadWikiMaintenanceRecovery(
  teamId: string,
): Promise<WikiPrepareSummary | null> {
  return (await loadWikiMaintenanceBootstrap(teamId)).recoveredSummary
}

export async function loadWikiMaintenanceBootstrap(teamId: string): Promise<{
  sourceDirectories: string[]
  compilerModel: string
  checkpointModel: string
  needsAdopt: boolean
  recoveredSummary: WikiPrepareSummary | null
}> {
  const status = await getBackend().wikiMaintainer.getStatus(teamId)
  const config = status.config?.config
  const sourceDirectories = wikiSourceFolders(
    Array.isArray(config?.sourceDirectories)
      ? config.sourceDirectories.filter(
          (path): path is string => typeof path === 'string',
        )
      : [],
  )
  const compilerModel =
    typeof config?.compilerModel === 'string' ? config.compilerModel : ''
  const manifest = status.checkpoint?.manifest
  const checkpointModel =
    manifest && typeof manifest.compilerModel === 'string' ? manifest.compilerModel : ''
  const vault =
    status.generation === 0
      ? await invoke<{ needsAdopt?: boolean }>('kb_maintainer_inspect_vault', {
          teamId,
        }).catch(() => ({ needsAdopt: false }))
      : { needsAdopt: false }
  if (
    status.stage !== 'ready_to_publish' &&
    status.stage !== 'publishing'
  ) {
    return {
      sourceDirectories,
      compilerModel,
      checkpointModel,
      needsAdopt: vault.needsAdopt === true,
      recoveredSummary: null,
    }
  }
  await restoreLatestCheckpoint(teamId, status)
  const recoveredSummary = await invoke<WikiPrepareSummary | null>(
    'kb_maintainer_recovered_summary',
    { teamId },
  )
  return {
    sourceDirectories,
    compilerModel,
    checkpointModel,
    needsAdopt: false,
    recoveredSummary,
  }
}

export async function discoverWikiSourceDirectories(
  teamId: string,
): Promise<WikiSourceDirectory[]> {
  const known = await listKnownDocuments(teamId)
  const response = await invoke<DiscoverResponse>('kb_maintainer_discover', {
    teamId,
    knownPaths: known.map((item) => item.path),
  })
  return response.directories
}

function teamCompilerId(id: string): string {
  const bare = id.trim()
  return bare.includes('/') ? bare : `team/${bare}`
}

async function loadTeamCompilerModels(teamId: string): Promise<WikiCompilerModel[]> {
  const llm = await getBackend().teamWorkspaceConfig.loadLlmConfig(teamId)
  if (!llm?.enabled) return []
  return (llm.models ?? [])
    .filter((model) => typeof model?.id === 'string' && model.id.trim() !== '')
    .map((model) => ({
      id: teamCompilerId(model.id),
      name: model.name || model.id.trim(),
      providerName: 'team',
    }))
}

/** Keep a previously saved compiler id when it is still in the list.
 *  Older saves stored the bare team model id (`glm-4.6`); the picker now
 *  uses `provider/model`. */
export function pickSavedCompilerModel(
  saved: string,
  models: WikiCompilerModel[],
): string {
  if (saved && models.some((model) => model.id === saved)) return saved
  if (saved && !saved.includes('/')) {
    const prefixed = teamCompilerId(saved)
    if (models.some((model) => model.id === prefixed)) return prefixed
  }
  return models[0]?.id ?? ''
}

export async function loadWikiCompilerModels(
  teamId: string,
): Promise<WikiCompilerModel[]> {
  const [deviceResult, teamResult] = await Promise.allSettled([
    loadDeviceModelOptions(teamId),
    loadTeamCompilerModels(teamId),
  ])
  const models: WikiCompilerModel[] = []
  const seen = new Set<string>()
  if (deviceResult.status === 'fulfilled') {
    for (const option of deviceResult.value.options) {
      const id = option.id?.trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      models.push({
        id,
        name: option.displayName?.trim() || id,
        providerName: option.providerName?.trim() || undefined,
      })
    }
  }
  if (teamResult.status === 'fulfilled') {
    for (const model of teamResult.value) {
      if (seen.has(model.id)) continue
      seen.add(model.id)
      models.push(model)
    }
  }
  if (models.length === 0) {
    const failed = [deviceResult, teamResult].find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') {
      throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason))
    }
  }
  return models
}

export async function prepareWikiMaintenance(
  teamId: string,
  sourceDirectories: string[],
  compilerModel: string,
): Promise<WikiPrepareSummary> {
  const folders = wikiSourceFolders(sourceDirectories)
  if (folders.length === 0) {
    throw new Error(
      'Choose a folder inside Documents. Files placed directly in Documents are not compiled.',
    )
  }
  const maintainer = getBackend().wikiMaintainer
  const status = await maintainer.getStatus(teamId)
  const desiredConfig = {
    schemaVersion: 1,
    sourceDirectories: folders,
    compilerModel,
  }
  let configVersion = status.config?.version ?? 0
  if (
    !status.config ||
    JSON.stringify(status.config.config) !== JSON.stringify(desiredConfig)
  ) {
    const saved = await maintainer.putConfig(teamId, {
      expectedVersion: configVersion,
      config: desiredConfig,
    })
    configVersion = saved.version
  }

  await restoreLatestCheckpoint(teamId, status)

  // Live owner/admin ACL list. Any failure stops before local files are touched.
  const acl = await getBackend().knowledgeAcl.listKnowledgeAcl(teamId)
  const known = await listKnownDocuments(teamId)
  const selectedKnown = known.filter((item) =>
    isUnderSelected(item.path, folders),
  )
  const [localPaths, importedPaths] = await Promise.all([
    invoke<string[]>('kb_maintainer_list_local_documents', {
      teamId,
      sourceDirectories: folders,
    }),
    invoke<string[]>('kb_maintainer_imported_source_paths', { teamId }),
  ])
  const local = new Set(localPaths)
  const imported = new Set(importedPaths)
  // Only lazy-fetch never-downloaded files. Paths already imported but missing
  // on disk were deleted by the user and must retract, not resurrect.
  const missing = selectedKnown
    .map((item) => item.path)
    .filter((path) => !local.has(path) && !imported.has(path))
  if (missing.length > 0) {
    const fetched = await fetchDocuments(teamId, missing)
    if (fetched !== missing.length) {
      throw new Error(
        `Could not download all selected source files (${fetched}/${missing.length}). Check the team sync connection and try again.`,
      )
    }
  }
  const { listen } = await import('@tauri-apps/api/event')
  let checkpointQueue = Promise.resolve()
  let checkpointFailure: unknown = null
  const unlisten = await listen<WikiCheckpointProgress>(
    'kb-maintainer:progress',
    (event) => {
      const checkpoint = event.payload
      if (
        checkpoint.stage !== 'checkpoint' ||
        checkpoint.manifest.teamId !== teamId
      ) {
        return
      }
      checkpointQueue = checkpointQueue.then(async () => {
        try {
          const prepared = await maintainer.prepareCheckpoint(teamId, {
            expectedGeneration: checkpoint.expectedGeneration,
            configVersion: checkpoint.configVersion,
            sha256: checkpoint.sha256,
            size: checkpoint.size,
          })
          if (prepared.requiresUpload) {
            if (!prepared.presignedPut) {
              throw new Error('Cloud API did not return a Wiki checkpoint upload URL.')
            }
            await invoke('kb_maintainer_upload_checkpoint', {
              request: {
                teamId,
                checkpointPath: checkpoint.checkpointPath,
                url: prepared.presignedPut,
                sha256: checkpoint.sha256,
                size: checkpoint.size,
              },
            })
          }
          await maintainer.completeCheckpoint(teamId, {
            expectedGeneration: checkpoint.expectedGeneration,
            configVersion: checkpoint.configVersion,
            sha256: checkpoint.sha256,
            size: checkpoint.size,
            objectKey: prepared.objectKey,
            manifest: checkpoint.manifest,
          })
          await invoke('kb_maintainer_ack_checkpoint', {
            teamId,
            generation: checkpoint.manifest.generation,
            accepted: true,
            manifest: checkpoint.manifest,
          })
        } catch (error) {
          checkpointFailure = error
          await invoke('kb_maintainer_ack_checkpoint', {
            teamId,
            generation: checkpoint.manifest.generation,
            accepted: false,
            manifest: null,
          })
        }
      })
    },
  )
  let summary: WikiPrepareSummary | undefined
  let prepareFailure: unknown = null
  try {
    summary = await invoke<WikiPrepareSummary>('kb_maintainer_prepare', {
      request: {
        teamId,
        sourceDirectories: folders,
        compilerModel,
        expectedGeneration: status.generation,
        configVersion,
        aclPrefixes: acl.map((rule) => rule.pathPrefix),
        known: selectedKnown,
      },
    })
  } catch (error) {
    prepareFailure = error
  } finally {
    await checkpointQueue
    unlisten()
  }
  if (checkpointFailure) {
    const latest = await maintainer.getStatus(teamId)
    await restoreLatestCheckpoint(teamId, latest)
    throw checkpointFailure
  }
  if (prepareFailure) throw prepareFailure
  if (!summary) throw new Error('Wiki compiler returned no summary.')
  return summary
}

export async function publishWikiMaintenance(
  teamId: string,
  summary: WikiPrepareSummary,
  acceptVisionCost: boolean,
): Promise<WikiPublishResult> {
  if (!summary.targetCommit || !summary.targetTreeHash || !summary.nodeId) {
    throw new Error('This Wiki summary predates portable publishing. Run maintenance again.')
  }
  const maintainer = getBackend().wikiMaintainer
  const status = await maintainer.getStatus(teamId)
  if (
    !status.config ||
    !status.checkpoint ||
    (status.stage !== 'ready_to_publish' && status.stage !== 'publishing')
  ) {
    throw new Error('The cloud Wiki checkpoint is not ready to publish.')
  }
  const checkpointTarget = status.checkpoint.manifest
  if (
    checkpointTarget.targetCommit !== summary.targetCommit ||
    checkpointTarget.targetTreeHash !== summary.targetTreeHash ||
    (checkpointTarget.baseTreeHash ?? null) !== (summary.baseTreeHash ?? null) ||
    checkpointTarget.nodeId !== summary.nodeId
  ) {
    throw new Error('The Wiki summary is stale. Reopen maintenance to load the latest checkpoint.')
  }
  const claim =
    status.stage === 'publishing'
      ? await maintainer.recoverPublish(teamId)
      : await maintainer.beginPublish(teamId, {
          generation: status.generation,
          configVersion: status.config.version,
          targetCommit: summary.targetCommit,
          targetTreeHash: summary.targetTreeHash,
          baseTreeHash: summary.baseTreeHash ?? null,
          nodeId: summary.nodeId,
        })
  const result = await invoke<WikiPublishResult>('kb_maintainer_publish', {
    teamId,
    runId: summary.runId,
    acceptVisionCost,
    cloudPublishingRecovery: status.stage === 'publishing',
    targetCommit: summary.targetCommit,
    targetTreeHash: summary.targetTreeHash,
    baseTreeHash: summary.baseTreeHash ?? null,
  })
  await maintainer.completePublish(teamId, {
    publishToken: claim.publishToken,
    syncStatus:
      result.syncStatus === 'synced'
        ? 'synced'
        : 'published_local_sync_pending',
  })
  try {
    const baseline = await invoke<{
      checkpointPath?: string
      expectedGeneration: number
      configVersion: number
      sha256: string
      size: number
      manifest: Record<string, unknown> & { generation?: number }
    }>('kb_maintainer_create_baseline', {
      request: {
        teamId,
        expectedGeneration: status.generation,
        configVersion: status.config.version,
        nodeId: summary.nodeId,
        compilerModel:
          typeof status.config.config.compilerModel === 'string'
            ? status.config.config.compilerModel
            : summary.nodeId,
      },
    })
    if (baseline?.checkpointPath) {
      await uploadCheckpointPackage(teamId, {
        expectedGeneration: baseline.expectedGeneration,
        configVersion: baseline.configVersion,
        checkpointPath: baseline.checkpointPath,
        sha256: baseline.sha256,
        size: baseline.size,
        manifest: baseline.manifest,
      })
    }
  } catch {
    // Publish already completed. A baseline can be written by the next checkpoint.
  }
  const syncRoot = useTeamShareBrowserStore.getState().syncRoot
  if (syncRoot) {
    await useWorkspaceStore.getState().refreshExternalRoot(syncRoot)
  }
  return result
}

export async function adoptExistingWiki(teamId: string): Promise<void> {
  const maintainer = getBackend().wikiMaintainer
  const status = await maintainer.getStatus(teamId)
  if (status.generation !== 0 || status.checkpoint) {
    throw new Error('This Wiki already has a cloud checkpoint.')
  }
  const adopted = await invoke<{
    checkpointPath: string
    expectedGeneration: number
    configVersion: number
    sha256: string
    size: number
    manifest: Record<string, unknown> & { generation?: number }
  }>('kb_maintainer_adopt_wiki', { teamId })
  await uploadCheckpointPackage(teamId, adopted)
}

export async function cancelWikiMaintenance(runId: string): Promise<void> {
  await invoke('kb_maintainer_cancel', { runId })
}
