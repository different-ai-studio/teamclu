import * as React from 'react'
import { useCurrentTeamStore } from '@/stores/current-team'
import {
  getCurrentDaemonWorkspaceAgent,
  listDaemonWorkspaces,
  type DaemonWorkspace,
} from '@/lib/daemon/daemon-workspaces'
import { loadGatewayModel } from '@/lib/daemon/amuxd-channels'
import { loadSelectableModelCatalog, type SelectableModel } from '@/lib/agent/selectable-models'
import { clientMruModels } from '@/stores/client-model-mru'
import { sessionDefaultModel } from './channel-runtime'

export interface ChannelRuntimeDefaults {
  ready: boolean
  workspaces: DaemonWorkspace[]
  models: SelectableModel[]
  /** Agent `defaultWorkspaceId` — what a channel uses when it has not chosen one. */
  inheritedWorkspaceId: string | null
  /** Gateway model, or the model a new chat session uses when that is unset. */
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
      let gatewayModel: string | null = null
      try {
        gatewayModel = (await loadGatewayModel())?.trim() || null
      } catch {
        gatewayModel = null
      }
      let defaultBackend = 'pi'
      try {
        // Same list as Maintain Wiki: device catalog, then team gateway models.
        const catalog = await loadSelectableModelCatalog(teamId)
        next.models = catalog.models
        defaultBackend = catalog.defaultBackend
      } catch {
        next.models = []
      }
      // A channel with no model of its own used to fall through to Pi's
      // internal default. Pin the model a new chat session would start on
      // instead, unless the gateway model is already set.
      next.inheritedModel =
        gatewayModel || sessionDefaultModel(next.models, clientMruModels(defaultBackend, teamId))
      if (!cancelled) setState(next)
    })()
    return () => {
      cancelled = true
    }
  }, [teamId])

  return state
}
