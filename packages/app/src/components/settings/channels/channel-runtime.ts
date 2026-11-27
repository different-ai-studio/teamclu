import { firstAvailableMruModel } from '@/stores/client-model-mru'

export interface ChannelRuntimeSelection {
  workspaceId?: string
  model?: string
}

export interface ChannelRuntimeInherited {
  workspaceId?: string | null
  model?: string | null
}

export function inheritedRuntime(defaults: {
  inheritedWorkspaceId: string | null
  inheritedModel: string | null
}): ChannelRuntimeInherited {
  return {
    workspaceId: defaults.inheritedWorkspaceId,
    model: defaults.inheritedModel,
  }
}

function nonempty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Model a new chat session would start on.
 *
 * The client's last explicit pick that this catalog still offers, otherwise
 * the first advertised model. An empty catalog returns null — there is nothing
 * to pin, and the channel must not pretend Pi's own default was chosen.
 */
export function sessionDefaultModel(
  models: readonly { id?: string }[],
  recent: readonly string[] | undefined,
): string | null {
  const fromRecent = firstAvailableMruModel(recent, models)
  if (fromRecent) return fromRecent
  const first = models.map((model) => model.id?.trim()).find((id): id is string => !!id)
  return first ?? null
}

/** Keep an explicit choice. An empty field takes the value the channel would
 * use today: the agent default workspace, then the gateway model, then the
 * model a new chat session uses. */
export function pinChannelRuntime<T extends ChannelRuntimeSelection>(
  config: T,
  inherited: ChannelRuntimeInherited,
): T {
  return {
    ...config,
    workspaceId: nonempty(config.workspaceId) ?? nonempty(inherited.workspaceId),
    model: nonempty(config.model) ?? nonempty(inherited.model),
  }
}
