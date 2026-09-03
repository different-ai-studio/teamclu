import type { SessionReport, ToolCallSummary, FeedbackRating, StarRating } from './types'
import { useSessionStore } from '@/stores/session-store'
import { type Message, type ToolCall } from '@/stores/session-types'
/**
 * Build a SessionReport from current session data.
 * Aggregates tokens, costs, tool calls, and message counts.
 */
export function buildSessionReport(
  sessionId: string,
  feedbackMap: Map<string, FeedbackRating>,
  starRatingMap?: Map<string, StarRating>,
): SessionReport | null {
  const state = useSessionStore.getState()

  // Find the session
  const session = state.sessions.find((s) => s.id === sessionId)
  if (!session) return null

  // Messages as loaded onto the mirrored session row by the telemetry store.
  const messages: Message[] = session.messages

  if (messages.length === 0) return null

  // Aggregate tokens
  let totalTokensInput = 0
  let totalTokensOutput = 0
  let totalTokensReasoning = 0
  let totalCacheRead = 0
  let totalCacheWrite = 0
  let totalCost = 0
  let messageCount = 0

  const allToolCalls: ToolCall[] = []
  let modelId: string | undefined
  let providerId: string | undefined
  let agent: string | undefined

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      messageCount++
      if (msg.tokens) {
        totalTokensInput += msg.tokens.input || 0
        totalTokensOutput += msg.tokens.output || 0
        totalTokensReasoning += msg.tokens.reasoning || 0
        totalCacheRead += msg.tokens.cache?.read || 0
        totalCacheWrite += msg.tokens.cache?.write || 0
      }
      if (msg.cost) {
        totalCost += msg.cost
      }
      if (msg.toolCalls) {
        allToolCalls.push(...msg.toolCalls)
      }
      if (msg.modelID || msg.providerID) {
        modelId = msg.modelID
        providerId = msg.providerID
      }
      if (msg.agent) {
        agent = msg.agent
      }
    }
  }

  // Build tool call summaries
  const toolCallSummaries: ToolCallSummary[] = allToolCalls.map((tc) => ({
    name: tc.name,
    status: tc.status === 'failed' ? 'failed' : 'completed',
    durationMs: tc.duration || 0,
  }))

  const toolErrorCount = allToolCalls.filter((tc) => tc.status === 'failed').length

  // Collect message IDs belonging to this session for filtering
  const sessionMessageIds = new Set(messages.map((m) => m.id))

  // Count feedbacks (only for messages in this session)
  let feedbackPositive = 0
  let feedbackNegative = 0
  for (const [msgId, rating] of feedbackMap.entries()) {
    if (!sessionMessageIds.has(msgId)) continue
    if (rating === 'positive') feedbackPositive++
    else if (rating === 'negative') feedbackNegative++
  }

  // Collect star ratings (only for messages in this session)
  const starRatings: number[] = []
  if (starRatingMap) {
    for (const [msgId, rating] of starRatingMap.entries()) {
      if (!sessionMessageIds.has(msgId)) continue
      starRatings.push(rating)
    }
  }

  // Determine timestamps
  const firstMsg = messages[0]
  const lastMsg = messages[messages.length - 1]
  const startedAt = firstMsg?.timestamp ? new Date(firstMsg.timestamp).getTime() : Date.now()
  const completedAt = lastMsg?.timestamp ? new Date(lastMsg.timestamp).getTime() : Date.now()

  const report: SessionReport & {
    _feedbackPositive?: number
    _feedbackNegative?: number
    _starRatings?: number[]
  } = {
    id: `report-${sessionId}-${Date.now()}`,
    session_id: sessionId,
    session_title: session.title || null,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: completedAt - startedAt,
    total_tokens_input: totalTokensInput,
    total_tokens_output: totalTokensOutput,
    total_tokens_reasoning: totalTokensReasoning,
    total_cache_read: totalCacheRead,
    total_cache_write: totalCacheWrite,
    total_cost: Math.round(totalCost * 10000) / 10000,
    message_count: messageCount,
    tool_call_count: allToolCalls.length,
    tool_error_count: toolErrorCount,
    tool_calls: JSON.stringify(toolCallSummaries),
    scores: null, // Will be filled by scoring engine
    model_id:
      modelId && providerId
        ? `${providerId}/${modelId}`
        : modelId || providerId || null,
    provider_id: providerId || null,
    agent: agent || null,
    created_at: new Date().toISOString(),
    // Internal metadata for scorers
    _feedbackPositive: feedbackPositive,
    _feedbackNegative: feedbackNegative,
    _starRatings: starRatings,
  }

  return report
}
