import { beforeEach, describe, expect, it, vi } from 'vitest'
import { distillWithTeamLlm } from '@/lib/knowledge/session-knowledge-llm'

const getFreshAccessToken = vi.fn()

vi.mock('@/lib/auth/session-store', () => ({
  getFreshAccessToken: () => getFreshAccessToken(),
}))

vi.mock('@/stores/team-mode', () => ({
  useTeamModeStore: {
    getState: () => ({
      teamModelConfig: {
        baseUrl: 'https://api.example.com/ai/v1/teams/t1',
        model: 'team-fast',
        modelName: 'Fast',
      },
    }),
  },
}))

describe('distillWithTeamLlm', () => {
  beforeEach(() => {
    getFreshAccessToken.mockReset()
    getFreshAccessToken.mockResolvedValue('tok')
  })

  it('returns a distilled draft from the team gateway', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  title: '对账口径',
                  suggestedPath: '20-domains/payments/对账口径.md',
                  summary: '以渠道单号为准',
                  suggestions: [{ kind: 'decision', text: '以渠道单号为准' }],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    const draft = await distillWithTeamLlm({
      title: '对账',
      messages: [{ content: '结论：以渠道单号为准', isAgent: true, kind: 1 }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(draft?.title).toBe('对账口径')
    expect(draft?.body).toContain('以渠道单号为准')
    expect(draft?.body).not.toContain('user:')
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('returns null when the gateway is down', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 502 }))
    const draft = await distillWithTeamLlm({
      title: '对账',
      messages: [{ content: 'x', isAgent: true, kind: 1 }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(draft).toBeNull()
  })
})
