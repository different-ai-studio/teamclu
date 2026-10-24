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

/** Keep an explicit choice. An empty field takes the value the channel would
 * use today: the agent default workspace, then `channels.model`. */
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
