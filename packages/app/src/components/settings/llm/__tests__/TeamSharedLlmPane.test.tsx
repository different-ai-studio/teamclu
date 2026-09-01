import * as React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

const cloud = vi.hoisted(() => ({
  loadLlmConfig: vi.fn(),
  saveLlmConfig: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    teamWorkspaceConfig: {
      loadLlmConfig: cloud.loadLlmConfig,
      saveLlmConfig: cloud.saveLlmConfig,
    },
  }),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (selector: (s: unknown) => unknown) =>
    selector({ team: { id: 'team-1', name: 'T', slug: 't' } }),
}))

import { TeamSharedLlmPane } from '../TeamSharedLlmPane'

describe('TeamSharedLlmPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cloud.saveLlmConfig.mockResolvedValue(undefined)
  })

  it('loads the team LLM config from the cloud when opened', async () => {
    cloud.loadLlmConfig.mockResolvedValue({
      enabled: true,
      baseUrl: 'https://proxy.example.com/v1',
      models: [{ id: 'gpt-x', name: 'GPT-X' }],
    })

    render(<TeamSharedLlmPane open onOpenChange={() => {}} />)

    await waitFor(() => {
      expect(cloud.loadLlmConfig).toHaveBeenCalledWith('team-1')
    })
    await waitFor(() => {
      const url = screen.getByPlaceholderText(
        'https://your-llm-proxy.com/v1',
      ) as HTMLInputElement
      expect(url.value).toBe('https://proxy.example.com/v1')
    })
  })

  it('persists via cloud saveLlmConfig only, fires onSaved, and closes', async () => {
    cloud.loadLlmConfig.mockResolvedValue({
      enabled: true,
      baseUrl: 'https://proxy.example.com/v1',
      models: [{ id: 'gpt-x', name: 'GPT-X' }],
    })
    const onSaved = vi.fn()
    const onOpenChange = vi.fn()

    render(<TeamSharedLlmPane open onOpenChange={onOpenChange} onSaved={onSaved} />)

    await waitFor(() => {
      expect(screen.getByPlaceholderText('https://your-llm-proxy.com/v1')).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: /保存|Save/ }))

    await waitFor(() => {
      expect(cloud.saveLlmConfig).toHaveBeenCalledWith('team-1', {
        enabled: true,
        baseUrl: 'https://proxy.example.com/v1',
        models: [{ id: 'gpt-x', name: 'GPT-X' }],
      })
    })
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('saves a disabled config to the cloud with no models', async () => {
    cloud.loadLlmConfig.mockResolvedValue({
      enabled: false,
      baseUrl: null,
      models: [],
    })

    render(<TeamSharedLlmPane open onOpenChange={() => {}} />)

    await waitFor(() => {
      expect(screen.getByText(/Host LLM/i)).toBeTruthy()
    })

    const saveBtn = screen.getByRole('button', { name: /保存|Save/ })
    await waitFor(() => expect(saveBtn).not.toBeDisabled())

    fireEvent.click(saveBtn)

    await waitFor(() => {
      expect(cloud.saveLlmConfig).toHaveBeenCalledWith('team-1', {
        enabled: false,
        baseUrl: null,
        models: [],
      })
    })
  })
})
