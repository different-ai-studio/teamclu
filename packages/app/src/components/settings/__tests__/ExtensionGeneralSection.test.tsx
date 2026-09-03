import * as React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const storage = vi.hoisted(() => ({
  value: { domains: [] as string[], urlPatterns: [] as string[] },
}))

const clearLinkSessionMapForTeam = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

vi.mock('@/lib/extension/link-session', () => ({
  clearLinkSessionMapForTeam,
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (selector: (state: { team: { id: string } | null }) => unknown) =>
    selector({ team: { id: 'team-1' } }),
}))

vi.mock('@/lib/extension/link-hover', () => ({
  readLinkHoverConfig: vi.fn(async () => ({
    domains: [...storage.value.domains],
    urlPatterns: [...storage.value.urlPatterns],
  })),
  writeLinkHoverConfig: vi.fn(async (config: { domains: string[]; urlPatterns: string[] }) => {
    storage.value = {
      domains: [...config.domains],
      urlPatterns: [...config.urlPatterns],
    }
  }),
  addDomainToConfig: vi.fn(
    (config: { domains: string[]; urlPatterns: string[] }, raw: string) => {
      const normalized = raw.trim().toLowerCase().replace(/^www\./, '')
      if (!normalized || !normalized.includes('.')) return { ok: false, error: 'invalid' as const }
      if (config.domains.includes(normalized)) return { ok: false, error: 'duplicate' as const }
      return { ok: true, config: { ...config, domains: [...config.domains, normalized] } }
    },
  ),
  removeDomainFromConfig: vi.fn(
    (config: { domains: string[]; urlPatterns: string[] }, domain: string) => ({
      ...config,
      domains: config.domains.filter((d) => d !== domain),
    }),
  ),
  addUrlPatternToConfig: vi.fn(
    (config: { domains: string[]; urlPatterns: string[] }, raw: string) => {
      const normalized = raw.trim()
      if (!normalized) return { ok: false, error: 'invalid' as const }
      if (config.urlPatterns.includes(normalized)) return { ok: false, error: 'duplicate' as const }
      return {
        ok: true,
        config: { ...config, urlPatterns: [...config.urlPatterns, normalized] },
      }
    },
  ),
  removeUrlPatternFromConfig: vi.fn(
    (config: { domains: string[]; urlPatterns: string[] }, pattern: string) => ({
      ...config,
      urlPatterns: config.urlPatterns.filter((p) => p !== pattern),
    }),
  ),
}))

describe('ExtensionGeneralSection', () => {
  beforeEach(() => {
    storage.value = { domains: [], urlPatterns: [] }
    clearLinkSessionMapForTeam.mockClear()
  })

  it('shows empty state and adds a domain to storage', async () => {
    const { ExtensionGeneralSection } = await import('../ExtensionGeneralSection')

    render(<ExtensionGeneralSection />)

    expect(
      await screen.findByText(
        'No domains configured — the quick-open button stays hidden on every site.',
      ),
    ).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('example.com'), {
      target: { value: 'example.com' },
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add' })[0]!)

    await waitFor(() => expect(screen.getByText('example.com')).toBeInTheDocument())
    expect(storage.value.domains).toEqual(['example.com'])
  })

  it('adds a URL pattern with * wildcards', async () => {
    const { ExtensionGeneralSection } = await import('../ExtensionGeneralSection')

    render(<ExtensionGeneralSection />)

    fireEvent.change(await screen.findByPlaceholderText('*/example/*'), {
      target: { value: '*/example/path/*' },
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add' })[1]!)

    await waitFor(() => expect(screen.getByText('*/example/path/*')).toBeInTheDocument())
    expect(storage.value.urlPatterns).toEqual(['*/example/path/*'])
  })

  it('clears link-session mappings for the current team after confirm', async () => {
    const { ExtensionGeneralSection } = await import('../ExtensionGeneralSection')
    const { toast } = await import('sonner')

    render(<ExtensionGeneralSection />)

    fireEvent.click(
      await screen.findByRole('button', { name: 'Clear current team mappings' }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Clear mappings' }))

    await waitFor(() => {
      expect(clearLinkSessionMapForTeam).toHaveBeenCalledWith('team-1')
    })
    expect(toast.success).not.toHaveBeenCalled()
  })
})
