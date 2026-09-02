import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/dynamic-ui/catalog', () => ({
  getCatalogPrompt: () => 'mock catalog prompt',
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('buildUIGenerationPrompt', () => {
  it('returns a string containing the user request', async () => {
    const { buildUIGenerationPrompt } = await import('@/lib/dynamic-ui/prompt')
    const result = buildUIGenerationPrompt('create a login form')
    expect(result).toContain('create a login form')
    expect(typeof result).toBe('string')
  })

  it('includes catalog prompt in output', async () => {
    const { buildUIGenerationPrompt } = await import('@/lib/dynamic-ui/prompt')
    const result = buildUIGenerationPrompt('test')
    expect(result).toContain('mock catalog prompt')
  })
})

describe('extractUITreeFromResponse', () => {
  it('extracts valid JSON from raw response', async () => {
    const { extractUITreeFromResponse } = await import('@/lib/dynamic-ui/generator')
    const json = JSON.stringify({ root: 'card', elements: { card: { key: 'card', type: 'Card' } } })
    const result = extractUITreeFromResponse(json)
    expect(result).not.toBeNull()
    expect(result?.root).toBe('card')
  })

  it('extracts JSON from markdown code block', async () => {
    const { extractUITreeFromResponse } = await import('@/lib/dynamic-ui/generator')
    const json = JSON.stringify({ root: 'card', elements: { card: { key: 'card', type: 'Card' } } })
    const result = extractUITreeFromResponse('```json\n' + json + '\n```')
    expect(result).not.toBeNull()
    expect(result?.root).toBe('card')
  })

  it('returns null for invalid JSON', async () => {
    const { extractUITreeFromResponse } = await import('@/lib/dynamic-ui/generator')
    const result = extractUITreeFromResponse('not json at all')
    expect(result).toBeNull()
  })

  it('returns null for valid JSON without root/elements', async () => {
    const { extractUITreeFromResponse } = await import('@/lib/dynamic-ui/generator')
    const result = extractUITreeFromResponse('{"foo": "bar"}')
    expect(result).toBeNull()
  })
})

describe('isUIGenerationRequest', () => {
  it('returns true for UI-related prompts', async () => {
    const { isUIGenerationRequest } = await import('@/lib/dynamic-ui/generator')
    expect(isUIGenerationRequest('create a login form')).toBe(true)
    expect(isUIGenerationRequest('generate UI')).toBe(true)
    expect(isUIGenerationRequest('build a dashboard')).toBe(true)
  })

  it('returns false for non-UI prompts', async () => {
    const { isUIGenerationRequest } = await import('@/lib/dynamic-ui/generator')
    expect(isUIGenerationRequest('what is the weather')).toBe(false)
    expect(isUIGenerationRequest('hello world')).toBe(false)
  })
})

describe('generateUI', () => {
  it('returns a login template for login-related prompt', async () => {
    const { generateUI } = await import('@/lib/dynamic-ui/generator')
    const result = await generateUI('create a login page')
    expect(result.tree).not.toBeNull()
    expect(result.title).toContain('login')
  })

  it('returns a generic UI for unmatched prompt', async () => {
    const { generateUI } = await import('@/lib/dynamic-ui/generator')
    const result = await generateUI('something completely custom')
    expect(result.tree).not.toBeNull()
  })
})

describe('getAvailableTemplates', () => {
  it('returns an array of template names', async () => {
    const { getAvailableTemplates } = await import('@/lib/dynamic-ui/generator')
    const templates = getAvailableTemplates()
    expect(Array.isArray(templates)).toBe(true)
    expect(templates.length).toBeGreaterThan(0)
    expect(templates).toContain('login')
    expect(templates).toContain('dashboard')
  })
})
