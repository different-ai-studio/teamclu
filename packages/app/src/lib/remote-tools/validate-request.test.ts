import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from '@bufbuild/protobuf'
import {
  RemoteToolInvokeRequestSchema,
  RpcRequestSchema,
} from '@/lib/proto/teamclu_pb'
import { useActorDirectoryStore } from '@/stores/actor-directory-store'
import { useSessionParticipantStore } from '@/stores/session-participant-store'

import {
  authorizeRemoteToolRequest,
  isAgentRequesterForRemoteToolRequest,
  isAllowedRemoteToolRequest,
} from '@/lib/remote-tools/validate-request'

const mockGetActorDirectoryEntry = vi.fn()
const mockListParticipants = vi.fn()

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    actors: {
      getActorDirectoryEntry: mockGetActorDirectoryEntry,
    },
    sessionMembers: {
      listParticipants: mockListParticipants,
    },
  }),
}))

describe('isAllowedRemoteToolRequest', () => {
  beforeEach(() => {
    mockGetActorDirectoryEntry.mockReset()
    mockListParticipants.mockReset()
    useActorDirectoryStore.setState({ byTeam: {}, activeTeamId: null })
    useSessionParticipantStore.setState({
      participantsBySession: {},
      loadingBySession: {},
      errorBySession: {},
    })
  })

  it('rejects member requester', () => {
    useActorDirectoryStore.setState({
      byTeam: {
        'team-1': {
          actors: [
            {
              id: 'member-1',
              actor_type: 'member',
              display_name: 'Alice',
              member_status: 'active',
              agent_status: null,
              last_active_at: null,
            },
          ],
          loading: false,
          error: false,
          started: true,
        },
      },
      activeTeamId: 'team-1',
    })

    const request = create(RpcRequestSchema, {
      requesterActorId: 'member-1',
      method: {
        case: 'remoteToolInvoke',
        value: create(RemoteToolInvokeRequestSchema, {
          sessionId: 'sess-1',
          toolName: 'get_page_dom',
          argumentsJson: '{}',
        }),
      },
    })

    expect(
      isAllowedRemoteToolRequest('team-1', request, request.method.value!),
    ).toBe(false)
  })

  it('detects non-agent requester before participant checks', () => {
    useActorDirectoryStore.setState({
      byTeam: {
        'team-1': {
          actors: [
            {
              id: 'member-1',
              actor_type: 'member',
              display_name: 'Alice',
              member_status: 'active',
              agent_status: null,
              last_active_at: null,
            },
          ],
          loading: false,
          error: false,
          started: true,
        },
      },
      activeTeamId: 'team-1',
    })

    const request = create(RpcRequestSchema, {
      requesterActorId: 'member-1',
      method: {
        case: 'remoteToolInvoke',
        value: create(RemoteToolInvokeRequestSchema, {
          sessionId: 'sess-1',
          toolName: 'get_page_dom',
          argumentsJson: '{}',
        }),
      },
    })

    expect(isAgentRequesterForRemoteToolRequest('team-1', request)).toBe(false)
  })

  it('rejects when session participants are not loaded', () => {
    useActorDirectoryStore.setState({
      byTeam: {
        'team-1': {
          actors: [
            {
              id: 'agent-1',
              actor_type: 'agent',
              display_name: 'Bot',
              member_status: null,
              agent_status: 'active',
              last_active_at: null,
            },
          ],
          loading: false,
          error: false,
          started: true,
        },
      },
      activeTeamId: 'team-1',
    })

    const request = create(RpcRequestSchema, {
      requesterActorId: 'agent-1',
      method: {
        case: 'remoteToolInvoke',
        value: create(RemoteToolInvokeRequestSchema, {
          sessionId: 'sess-1',
          toolName: 'get_page_dom',
          argumentsJson: '{}',
        }),
      },
    })

    expect(
      isAllowedRemoteToolRequest('team-1', request, request.method.value!),
    ).toBe(false)
  })

  it('allows agent requester in session participants', () => {
    useActorDirectoryStore.setState({
      byTeam: {
        'team-1': {
          actors: [
            {
              id: 'agent-1',
              actor_type: 'agent',
              display_name: 'Bot',
              member_status: null,
              agent_status: 'active',
              last_active_at: null,
            },
          ],
          loading: false,
          error: false,
          started: true,
        },
      },
      activeTeamId: 'team-1',
    })
    useSessionParticipantStore.setState({
      participantsBySession: {
        'sess-1': [
          {
            actorId: 'agent-1',
            displayName: 'Bot',
            avatarUrl: null,
            isAgent: true,
          },
        ],
      },
      loadingBySession: {},
      errorBySession: {},
    })

    const request = create(RpcRequestSchema, {
      requesterActorId: 'agent-1',
      method: {
        case: 'remoteToolInvoke',
        value: create(RemoteToolInvokeRequestSchema, {
          sessionId: 'sess-1',
          toolName: 'get_page_dom',
          argumentsJson: '{}',
        }),
      },
    })

    expect(
      isAllowedRemoteToolRequest('team-1', request, request.method.value!),
    ).toBe(true)
  })
})

describe('authorizeRemoteToolRequest', () => {
  beforeEach(() => {
    mockGetActorDirectoryEntry.mockReset()
    mockListParticipants.mockReset()
    useActorDirectoryStore.setState({ byTeam: {}, activeTeamId: null })
    useSessionParticipantStore.setState({
      participantsBySession: {},
      loadingBySession: {},
      errorBySession: {},
    })
  })

  it('falls back to Cloud API when participants cache is empty', async () => {
    useActorDirectoryStore.setState({
      byTeam: {
        'team-1': {
          actors: [
            {
              id: 'agent-1',
              actor_type: 'agent',
              display_name: 'Bot',
              member_status: null,
              agent_status: 'active',
              last_active_at: null,
            },
          ],
          loading: false,
          error: false,
          started: true,
        },
      },
      activeTeamId: 'team-1',
    })
    useSessionParticipantStore.setState({
      participantsBySession: { 'sess-1': [] },
      loadingBySession: {},
      errorBySession: {},
    })
    mockListParticipants.mockResolvedValue([
      {
        id: 'agent-1',
        actor_type: 'agent',
        display_name: 'Bot',
        avatar_url: null,
      },
    ])

    const request = create(RpcRequestSchema, {
      requesterActorId: 'agent-1',
      method: {
        case: 'remoteToolInvoke',
        value: create(RemoteToolInvokeRequestSchema, {
          sessionId: 'sess-1',
          toolName: 'get_page_dom',
          argumentsJson: '{}',
        }),
      },
    })

    await expect(
      authorizeRemoteToolRequest('team-1', request, request.method.value!),
    ).resolves.toBe(true)
    expect(mockListParticipants).toHaveBeenCalledWith('sess-1')
  })

  it('falls back to actor directory API when store is cold', async () => {
    mockGetActorDirectoryEntry.mockResolvedValue({
      id: 'agent-1',
      actor_type: 'agent',
      display_name: 'Bot',
      avatar_url: null,
    })
    useSessionParticipantStore.setState({
      participantsBySession: {
        'sess-1': [
          {
            actorId: 'agent-1',
            displayName: 'Bot',
            avatarUrl: null,
            isAgent: true,
          },
        ],
      },
      loadingBySession: {},
      errorBySession: {},
    })

    const request = create(RpcRequestSchema, {
      requesterActorId: 'agent-1',
      method: {
        case: 'remoteToolInvoke',
        value: create(RemoteToolInvokeRequestSchema, {
          sessionId: 'sess-1',
          toolName: 'get_page_dom',
          argumentsJson: '{}',
        }),
      },
    })

    await expect(
      authorizeRemoteToolRequest('team-1', request, request.method.value!),
    ).resolves.toBe(true)
    expect(mockGetActorDirectoryEntry).toHaveBeenCalledWith('agent-1')
  })
})
