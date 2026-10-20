import type { CloudApiClient } from './http'

export type WikiMaintainerStage =
  | 'idle'
  | 'ready_to_publish'
  | 'publishing'
  | 'sync_pending'
  | 'needs_attention'

export interface WikiCheckpointManifest {
  [key: string]: unknown
}

export interface WikiCheckpoint {
  id: string
  generation: number
  parentGeneration: number
  objectKey: string
  sha256: string
  size: number
  manifest: WikiCheckpointManifest
  createdBy: string
  createdAt: string
}

export interface WikiMaintainerStatus {
  config: { version: number; config: Record<string, unknown>; updatedAt: string } | null
  generation: number
  stage: WikiMaintainerStage
  publishedCommit?: string | null
  checkpoint: WikiCheckpoint | null
  publishing: Record<string, unknown> | null
  syncStatus: string | null
  updatedAt: string | null
}

export interface WikiCheckpointWrite {
  expectedGeneration: number
  configVersion: number
  sha256: string
  size: number
}

export interface WikiMaintainerBackend {
  getStatus(teamId: string): Promise<WikiMaintainerStatus>
  putConfig(
    teamId: string,
    input: { expectedVersion: number; config: Record<string, unknown> },
  ): Promise<{ version: number; config: Record<string, unknown>; updatedAt: string }>
  prepareCheckpoint(
    teamId: string,
    input: WikiCheckpointWrite,
  ): Promise<WikiCheckpointWrite & {
    objectKey: string
    requiresUpload: boolean
    presignedPut: string | null
  }>
  completeCheckpoint(
    teamId: string,
    input: WikiCheckpointWrite & {
      objectKey: string
      manifest: WikiCheckpointManifest
    },
  ): Promise<{ generation: number; stage: WikiMaintainerStage; checkpointId: string }>
  downloadLatestCheckpoint(
    teamId: string,
  ): Promise<WikiCheckpoint & { url: string }>
  downloadCheckpoint(
    teamId: string,
    generation: number,
  ): Promise<WikiCheckpoint & { url: string }>
  beginPublish(
    teamId: string,
    input: {
      generation: number
      configVersion: number
      targetCommit: string
      targetTreeHash: string
      baseTreeHash: string | null
      nodeId: string
    },
  ): Promise<{ stage: 'publishing'; publishing: Record<string, unknown>; publishToken: string }>
  completePublish(
    teamId: string,
    input: {
      publishToken: string
      syncStatus: 'synced' | 'published_local_sync_pending'
    },
  ): Promise<WikiMaintainerStatus>
  recoverPublish(
    teamId: string,
  ): Promise<{ stage: 'publishing'; publishing: Record<string, unknown>; publishToken: string }>
}

export function createWikiMaintainerModule(client: CloudApiClient): WikiMaintainerBackend {
  const base = (teamId: string) =>
    `/v1/teams/${encodeURIComponent(teamId)}/wiki-maintainer`

  return {
    getStatus: (teamId) => client.get(base(teamId)),
    putConfig: (teamId, input) => client.put(`${base(teamId)}/config`, input),
    prepareCheckpoint: (teamId, input) =>
      client.post(`${base(teamId)}/checkpoints/prepare`, input),
    completeCheckpoint: (teamId, input) =>
      client.post(`${base(teamId)}/checkpoints/complete`, input),
    downloadLatestCheckpoint: (teamId) =>
      client.get(`${base(teamId)}/checkpoints/latest/download`),
    downloadCheckpoint: (teamId, generation) =>
      client.get(`${base(teamId)}/checkpoints/${generation}/download`),
    beginPublish: (teamId, input) =>
      client.post(`${base(teamId)}/publish/begin`, input),
    completePublish: (teamId, input) =>
      client.post(`${base(teamId)}/publish/complete`, input),
    recoverPublish: (teamId) =>
      client.post(`${base(teamId)}/publish/recover`, {}),
  }
}
