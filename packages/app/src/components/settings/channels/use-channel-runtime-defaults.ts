import * as React from 'react'
import { useCurrentTeamStore } from '@/stores/current-team'
import {
  getCurrentDaemonWorkspaceAgent,
  listDaemonWorkspaces,
  type DaemonWorkspace,
} from '@/lib/daemon/daemon-workspaces'
import { loadGatewayModel } from '@/lib/daemon/amuxd-channels'
import { loadDeviceModelOptions, type DeviceModelOption } from '@/lib/agent/device-default-models'

export interface ChannelRuntimeDefaults {
  ready: boolean
  workspaces: DaemonWorkspace[]
  models: DeviceModelOption[]
  /** Agent `defaultWorkspaceId` — what a channel uses when it has not chosen one. */
  inheritedWorkspaceId: string | null
  /** `channels.model` — what a channel uses when it has not chosen a model. */
  inheritedModel: string | null
}

const EMPTY: ChannelRuntimeDefaults = {
  ready: false,
  workspaces: [],
  models: [],
  inheritedWorkspaceId: null,
  inheritedModel: null,
}

export function useChannelRuntimeDefaults(): ChannelRuntimeDefaults {
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const [state, setState] = React.useState<ChannelRuntimeDefaults>(EMPTY)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      const next: ChannelRuntimeDefaults = {
        ready: true,
        workspaces: [],
        models: [],
        inheritedWorkspaceId: null,
        inheritedModel: null,
      }
      try {
        if (teamId) {
          const agent = await getCurrentDaemonWorkspaceAgent(teamId).catch(() => null)
          const list = agent ? await listDaemonWorkspaces(teamId, agent.id).catch(() => []) : []
          next.workspaces = list.filter((workspace) => !workspace.archived)
          const inherited = agent?.defaultWorkspaceId?.trim() || null
          next.inheritedWorkspaceId = inherited
        }
      } catch {
        // Leave the lists empty; the fields still save a hand-entered id.
      }
      try {
        next.inheritedModel = (await loadGatewayModel())?.trim() || null
      } catch {
        next.inheritedModel = null
      }
      try {
        const catalog = await loadDeviceModelOptions(teamId)
        next.models = catalog.options
      } catch {
        next.models = []
      }
      if (!cancelled) setState(next)
    })()
    return () => {
      cancelled = true
    }
  }, [teamId])

  return state
}
