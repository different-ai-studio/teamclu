import { invoke } from '@tauri-apps/api/core'

import { getBackend } from '@/lib/backend/provider'
import {
  fetchDocuments,
  listKnownDocuments,
} from '@/lib/daemon/daemon-local-client'
import { useTeamShareBrowserStore } from '@/stores/team-share-browser'
import { useWorkspaceStore } from '@/stores/workspace'
import type {
  WikiPrepareSummary,
  WikiPublishResult,
  WikiSourceDirectory,
} from '@/components/teamshare/WikiMaintainerRunSheet'

interface DiscoverResponse {
  directories: WikiSourceDirectory[]
}

function isUnderSelected(path: string, selected: string[]): boolean {
  return selected.some((prefix) => path.startsWith(prefix))
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

export async function prepareWikiMaintenance(
  teamId: string,
  sourceDirectories: string[],
): Promise<WikiPrepareSummary> {
  // Live owner/admin ACL list. Any failure stops before local files are touched.
  const acl = await getBackend().knowledgeAcl.listKnowledgeAcl(teamId)
  const known = await listKnownDocuments(teamId)
  const selectedKnown = known.filter((item) =>
    isUnderSelected(item.path, sourceDirectories),
  )
  const [localPaths, importedPaths] = await Promise.all([
    invoke<string[]>('kb_maintainer_list_local_documents', {
      teamId,
      sourceDirectories,
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
  return invoke<WikiPrepareSummary>('kb_maintainer_prepare', {
    request: {
      teamId,
      sourceDirectories,
      aclPrefixes: acl.map((rule) => rule.pathPrefix),
      known: selectedKnown,
    },
  })
}

export async function publishWikiMaintenance(
  runId: string,
  acceptVisionCost: boolean,
): Promise<WikiPublishResult> {
  const result = await invoke<WikiPublishResult>('kb_maintainer_publish', {
    runId,
    acceptVisionCost,
  })
  const syncRoot = useTeamShareBrowserStore.getState().syncRoot
  if (syncRoot) {
    await useWorkspaceStore.getState().refreshExternalRoot(syncRoot)
  }
  return result
}

export async function cancelWikiMaintenance(runId: string): Promise<void> {
  await invoke('kb_maintainer_cancel', { runId })
}
