import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createIdeaActivity, updateIdea, updateIdeaStatus, renameIdea } from '@/lib/team/idea-mutations'

const getIdeaDetailMock = vi.fn()
const updateIdeaMock = vi.fn()
const createIdeaActivityMock = vi.fn()
const getSessionMock = vi.fn()
const getCurrentTeamMemberMock = vi.fn()

let currentMemberState: { id: string } | null = null

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    auth: { getSession: getSessionMock },
    directory: { getCurrentTeamMember: getCurrentTeamMemberMock },
    ideas: {
      getIdeaDetail: getIdeaDetailMock,
      updateIdea: updateIdeaMock,
      createIdeaActivity: createIdeaActivityMock,
    },
  }),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: {
    getState: () => ({ currentMember: currentMemberState }),
  },
}))

beforeEach(() => {
  getIdeaDetailMock.mockReset()
  updateIdeaMock.mockReset()
  createIdeaActivityMock.mockReset()
  getSessionMock.mockReset()
  getCurrentTeamMemberMock.mockReset()
  currentMemberState = { id: 'actor-1' }
  updateIdeaMock.mockResolvedValue(undefined)
  createIdeaActivityMock.mockResolvedValue(undefined)
})

describe('updateIdeaStatus', () => {
  it('reads the full idea then calls update_idea with new status', async () => {
    getIdeaDetailMock.mockResolvedValue({ workspace_id: 'ws-1', title: 'T', description: 'D', status: 'open' })

    await updateIdeaStatus('idea-1', 'in_progress')

    expect(updateIdeaMock).toHaveBeenCalledWith({
      ideaId: 'idea-1',
      workspaceId: 'ws-1',
      title: 'T',
      description: 'D',
      status: 'in_progress',
    })
  })

  it('throws when fetch fails', async () => {
    getIdeaDetailMock.mockRejectedValue(new Error('not found'))
    await expect(updateIdeaStatus('idea-1', 'done')).rejects.toThrow('not found')
    expect(updateIdeaMock).not.toHaveBeenCalled()
  })

  it('throws when rpc errors', async () => {
    getIdeaDetailMock.mockResolvedValue({ workspace_id: null, title: 'T', description: null, status: null })
    updateIdeaMock.mockRejectedValue(new Error('rpc failed'))
    await expect(updateIdeaStatus('idea-1', 'done')).rejects.toThrow('rpc failed')
  })
})

describe('renameIdea', () => {
  it('trims and writes new title with existing status fallback to open', async () => {
    getIdeaDetailMock.mockResolvedValue({ workspace_id: 'ws-1', title: 'old', description: 'D', status: null })

    await renameIdea('idea-1', '  new title  ')

    expect(updateIdeaMock).toHaveBeenCalledWith({
      ideaId: 'idea-1',
      workspaceId: 'ws-1',
      title: 'new title',
      description: 'D',
      status: 'open',
    })
  })

  it('rejects empty / whitespace title', async () => {
    await expect(renameIdea('idea-1', '   ')).rejects.toThrow('title is required')
    expect(getIdeaDetailMock).not.toHaveBeenCalled()
  })
})

describe('updateIdea', () => {
  it('calls update_idea with explicit editable fields', async () => {
    await updateIdea('idea-1', {
      workspaceId: null,
      title: ' Edited ',
      description: 'Details',
      status: 'done',
    })

    expect(updateIdeaMock).toHaveBeenCalledWith({
      ideaId: 'idea-1',
      workspaceId: null,
      title: 'Edited',
      description: 'Details',
      status: 'done',
    })
  })
})

describe('createIdeaActivity', () => {
  it('posts with the current member actor id', async () => {
    await createIdeaActivity('idea-1', {
      activityType: 'progress',
      content: 'shipped first pass',
    })

    expect(createIdeaActivityMock).toHaveBeenCalledWith({
      ideaId: 'idea-1',
      actorId: 'actor-1',
      activityType: 'progress',
      content: 'shipped first pass',
      metadata: {},
    })
  })

  it('falls back to resolving the actor via the idea team when the store is empty', async () => {
    currentMemberState = null
    getSessionMock.mockResolvedValue({ user: { id: 'u-1' } })
    getIdeaDetailMock.mockResolvedValue({ team_id: 'team-1' })
    getCurrentTeamMemberMock.mockResolvedValue({ id: 'actor-2' })

    await createIdeaActivity('idea-1', {
      activityType: 'progress',
      content: 'note',
    })

    expect(getCurrentTeamMemberMock).toHaveBeenCalledWith('team-1', 'u-1')
    expect(createIdeaActivityMock).toHaveBeenCalledWith({
      ideaId: 'idea-1',
      actorId: 'actor-2',
      activityType: 'progress',
      content: 'note',
      metadata: {},
    })
  })

  it('throws without posting when no member actor can be resolved', async () => {
    currentMemberState = null
    getSessionMock.mockResolvedValue(null)

    await expect(
      createIdeaActivity('idea-1', { activityType: 'progress', content: 'note' }),
    ).rejects.toThrow('member actor not found')
    expect(createIdeaActivityMock).not.toHaveBeenCalled()
  })
})
