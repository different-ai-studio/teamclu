import { getBackend } from '@/lib/backend/provider'
import { loadDeviceModelOptions } from '@/lib/agent/device-default-models'

/**
 * Models a person can pick for a run on this team: the device catalog, then
 * the team gateway. Wiki maintenance and channel runtime share this list so
 * the two pickers cannot drift.
 */
export interface SelectableModel {
  /** ACP model ref, stored verbatim (`provider/model`). */
  id: string
  displayName: string
  /** Provider segment, for the picker's grouping. Team gateway models use `team`. */
  providerName?: string
}

/** Older team configs stored a bare id (`glm-4.6`). The picker uses `team/<id>`. */
export function teamModelId(id: string): string {
  const bare = id.trim()
  return bare.includes('/') ? bare : `team/${bare}`
}

export function groupModelsByProvider<T extends { providerName?: string }>(
  models: T[],
): { label: string; models: T[] }[] {
  const groups = new Map<string, T[]>()
  for (const model of models) {
    const label = model.providerName?.trim() || ''
    const list = groups.get(label)
    if (list) list.push(model)
    else groups.set(label, [model])
  }
  return [...groups.entries()].map(([label, groupModels]) => ({
    label,
    models: groupModels,
  }))
}

async function loadTeamModels(teamId: string): Promise<SelectableModel[]> {
  const llm = await getBackend().teamWorkspaceConfig.loadLlmConfig(teamId)
  if (!llm?.enabled) return []
  return (llm.models ?? [])
    .filter((model) => typeof model?.id === 'string' && model.id.trim() !== '')
    .map((model) => ({
      id: teamModelId(model.id),
      displayName: model.name?.trim() || model.id.trim(),
      providerName: 'team',
    }))
}

export async function loadSelectableModels(teamId: string): Promise<SelectableModel[]> {
  const [deviceResult, teamResult] = await Promise.allSettled([
    loadDeviceModelOptions(teamId),
    loadTeamModels(teamId),
  ])
  const models: SelectableModel[] = []
  const seen = new Set<string>()
  if (deviceResult.status === 'fulfilled') {
    for (const option of deviceResult.value.options) {
      const id = option.id?.trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      models.push({
        id,
        displayName: option.displayName?.trim() || id,
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
