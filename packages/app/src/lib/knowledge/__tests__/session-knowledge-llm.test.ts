import { beforeEach, describe, expect, it, vi } from 'vitest'
import { distillDocumentWithTeamLlm, distillWithTeamLlm } from '@/lib/knowledge/session-knowledge-llm'

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

  it('distills a document excerpt with a document-specific prompt', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  title: '合同要点',
                  suggestedPath: '20-domains/合同.md',
                  summary: '以盖章版为准',
                  suggestions: [{ kind: 'decision', text: '以盖章版为准' }],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    const draft = await distillDocumentWithTeamLlm({
      title: '合同',
      text: '结论：以盖章版为准。',
      documentPath: 'documents/hr/合同.md',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(draft?.title).toBe('合同要点')
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as { body: string }).body) as {
      messages: Array<{ role: string; content: string }>
    }
    expect(body.messages[0].content).toContain('资料')
    expect(body.messages[1].content).toContain('documents/hr/合同.md')
    expect(body.messages[1].content).not.toMatch(/^会话标题/)
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
