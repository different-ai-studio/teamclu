import { getFreshAccessToken } from '@/lib/auth/session-store'
import {
  compactTranscriptForDistill,
  parseDistillPayload,
  type SessionDraftMessage,
  type SessionKnowledgeDraft,
} from '@/lib/knowledge/session-knowledge-draft'
import { useTeamModeStore } from '@/stores/team-mode'

const JSON_SHAPE = `只返回 JSON：
{"title":"短标题","suggestedPath":"20-domains/<slug>.md","summary":"不超过80字的一句话共识","suggestions":[{"kind":"decision|fact|followup","text":"一条可独立收入知识库的句子"}]}
suggestions 3到8条。kind 只能是 decision、fact、followup。`

const SESSION_SYSTEM_PROMPT = `你把一段团队会话提炼成知识库草稿。不要复述聊天过程，不要粘贴原文。
只保留已经达成的共识、决策、口径、后续动作。
${JSON_SHAPE}`

const DOCUMENT_SYSTEM_PROMPT = `你把一份团队资料提炼成知识库草稿。不要粘贴原文全文。
只保留已经写明的结论、口径、要点、后续动作。资料仍在资料库，知识页是共识摘要。
${JSON_SHAPE}`

async function runTeamDistill(input: {
  system: string
  user: string
  fetchImpl?: typeof fetch
}): Promise<SessionKnowledgeDraft | null> {
  const config = useTeamModeStore.getState().teamModelConfig
  if (!config?.baseUrl || !config.model) return null
  if (!input.user.trim()) return null

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
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
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

export async function distillWithTeamLlm(input: {
  title: string
  messages: SessionDraftMessage[]
  fetchImpl?: typeof fetch
}): Promise<SessionKnowledgeDraft | null> {
  const transcript = compactTranscriptForDistill(input.messages)
  return runTeamDistill({
    system: SESSION_SYSTEM_PROMPT,
    user: `会话标题：${input.title || '（无）'}\n\n${transcript}`,
    fetchImpl: input.fetchImpl,
  })
}

export async function distillDocumentWithTeamLlm(input: {
  title: string
  text: string
  documentPath: string
  fetchImpl?: typeof fetch
}): Promise<SessionKnowledgeDraft | null> {
  const trimmed = input.text.trim()
  if (!trimmed) return null
  const excerpt = trimmed.length <= 6000 ? trimmed : trimmed.slice(0, 6000)
  return runTeamDistill({
    system: DOCUMENT_SYSTEM_PROMPT,
    user: `资料标题：${input.title || '（无）'}\n资料路径：${input.documentPath}\n\n${excerpt}`,
    fetchImpl: input.fetchImpl,
  })
}
