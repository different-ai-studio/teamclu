import * as React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useTeamShareBrowserStore, type TeamSkillItem } from '@/stores/team-share-browser'

const { put } = vi.hoisted(() => ({ put: vi.fn(async () => ({})) }))
const t = (key: string, fallback?: string) => fallback ?? key
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }))
vi.mock('@/lib/daemon/daemon-local-client', () => ({
  encodeWorkspaceId: (path: string) => path,
  putDaemonSkill: put,
}))
vi.mock('@/lib/workspace/effective-workspace', () => ({ useEffectiveWorkspacePath: () => '/workspace' }))
vi.mock('@/lib/team/team-permissions', () => ({ useTeamPermissions: () => ({ canManageTeam: false }) }))
vi.mock('@/components/sidebar/TeamShareListColumn', () => ({ DeleteTeamSkillDialog: () => null }))
vi.mock('@/components/editors/CodeEditor', () => ({
  default: ({ content, onChange, readOnly = false }: { content: string; onChange: (value: string) => void; readOnly?: boolean }) => (
    <textarea aria-label="Skill content" value={content} readOnly={readOnly} onChange={(e) => onChange(e.target.value)} />
  ),
}))

import { SkillDetail } from '../SkillDetail'

const personal: TeamSkillItem = {
  id: 'personal:deploy-app', slug: 'deploy-app', name: 'deploy-app', invocationName: 'deploy-app',
  category: null, content: 'bundled instructions', dirPath: '/skills', filename: 'deploy-app',
  origin: 'personal', kind: 'personal', personalSource: 'builtin', personalSourceLabel: 'Built-in',
  summary: null, whenToUse: null, whenNotToUse: null, requires: null, status: null,
  supersededBy: null, ownerActorId: null, latestVersion: null, installed: true, installedVersion: null,
  hasUpdate: false, createdAt: null, updatedAt: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  useTeamShareBrowserStore.setState({
    skills: { items: [personal], loading: false, loaded: true, error: null },
    skillLocalState: {}, skillSyncErrors: {}, skillArchived: {}, skillRetired: {}, subjectActorId: null,
    loadSection: vi.fn(async () => {}), reconcileSkills: vi.fn(async () => {}),
  })
})

describe('SkillDetail built-in protection', () => {
  it('shows built-in instructions read-only without save or delete actions', async () => {
    render(<SkillDetail slug="personal:deploy-app" />)
    const editor = await screen.findByRole('textbox', { name: 'Skill content' })
    expect((editor as HTMLTextAreaElement).readOnly).toBe(true)
    expect((editor as HTMLTextAreaElement).value).toBe('bundled instructions')
    expect(screen.queryByRole('button', { name: 'Save to this device' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
  })

  it('keeps ordinary personal skill editing and saving available', async () => {
    useTeamShareBrowserStore.setState({ skills: {
      items: [{ ...personal, personalSource: 'global-agent', personalSourceLabel: 'Global' }],
      loading: false, loaded: true, error: null,
    } })
    render(<SkillDetail slug="personal:deploy-app" />)
    const editor = await screen.findByRole('textbox', { name: 'Skill content' })
    expect((editor as HTMLTextAreaElement).readOnly).toBe(false)
    fireEvent.change(editor, { target: { value: 'my instructions' } })
    expect((screen.getByRole('button', { name: 'Save to this device' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Save to this device' }))
    expect(put).toHaveBeenCalledWith('/workspace', 'deploy-app', expect.objectContaining({ content: 'my instructions' }))
  })
})
