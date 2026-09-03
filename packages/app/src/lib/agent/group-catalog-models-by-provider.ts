type CatalogModelOption = { id: string; name: string }

type CatalogProviderGroup = {
  providerId: string
  models: CatalogModelOption[]
}

function splitProviderModel(id: string): { providerId: string; modelId: string } | null {
  const trimmed = id.trim()
  if (!trimmed) return null
  const slash = trimmed.indexOf('/')
  if (slash <= 0) return { providerId: trimmed, modelId: trimmed }
  return {
    providerId: trimmed.slice(0, slash),
    modelId: trimmed.slice(slash + 1),
  }
}

export function groupCatalogModelsByProvider(
  models: ReadonlyArray<{ id: string; displayName?: string | null }>,
): CatalogProviderGroup[] {
  const groups: CatalogProviderGroup[] = []
  const byProvider = new Map<string, CatalogProviderGroup>()
  const seen = new Set<string>()

  for (const model of models) {
    const id = model.id?.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const parts = splitProviderModel(id)
    if (!parts) continue
    const name = model.displayName?.trim() || id
    let group = byProvider.get(parts.providerId)
    if (!group) {
      group = { providerId: parts.providerId, models: [] }
      byProvider.set(parts.providerId, group)
      groups.push(group)
    }
    group.models.push({ id, name })
  }

  return groups
}

export function catalogModelsForProvider(
  models: ReadonlyArray<{ id: string; displayName?: string | null }>,
  providerId: string,
): CatalogModelOption[] {
  return groupCatalogModelsByProvider(models).find((g) => g.providerId === providerId)?.models ?? []
}
