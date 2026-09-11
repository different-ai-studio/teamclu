import { getFreshAccessToken } from '@/lib/auth/session-store'
import {
  compactTranscriptForDistill,
  parseDistillPayload,
  type SessionDraftMessage,
  type SessionKnowledgeDraft,
} from '@/lib/knowledge/session-knowledge-draft'
import { useTeamModeStore } from '@/stores/team-mode'

const SYSTEM_PROMPT = `你把一段团队会话提炼成知识库草稿。不要复述聊天过程，不要粘贴原文。
只保留已经达成的共识、决策、口径、后续动作。
只返回 JSON：
{"title":"短标题","suggestedPath":"20-domains/<slug>.md","summary":"不超过80字的一句话共识","suggestions":[{"kind":"decision|fact|followup","text":"一条可独立收入知识库的句子"}]}
suggestions 3到8条。kind 只能是 decision、fact、followup。`

export async function distillWithTeamLlm(input: {
  title: string
  messages: SessionDraftMessage[]
  fetchImpl?: typeof fetch
}): Promise<SessionKnowledgeDraft | null> {
  const config = useTeamModeStore.getState().teamModelConfig
  if (!config?.baseUrl || !config.model) return null
  const transcript = compactTranscriptForDistill(input.messages)
  if (!transcript.trim()) return null

  let token: string
  try {
    token = await getFreshAccessToken()
  } catch {
    return null
  }
  if (!token.trim()) return null

  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const fetchFn = input.fetchImpl ?? fetch
  let resp: Response
  try {
    resp = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `会话标题：${input.title || '（无）'}\n\n${transcript}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    return null
  }
  if (!resp.ok) return null
  const data = (await resp.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>
  } | null
  const content = data?.choices?.[0]?.message?.content
  if (!content) return null
  return parseDistillPayload(content)
}
