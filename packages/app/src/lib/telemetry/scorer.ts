import type { ScoreResult, SessionReport, ToolCallSummary } from '@/lib/telemetry/types'

// ─── Scorer Interface ────────────────────────────────────────────────────

export interface Scorer {
  id: string
  name: string
  type: 'rule' | 'llm'
  score(report: SessionReport): Promise<ScoreResult | null>
}

// ─── Helper ──────────────────────────────────────────────────────────────

function parseToolCalls(report: SessionReport): ToolCallSummary[] {
  if (!report.tool_calls) return []
  try {
    return JSON.parse(report.tool_calls) as ToolCallSummary[]
  } catch {
    return []
  }
}

// ─── User Feedback Scorer ────────────────────────────────────────────────

export class UserFeedbackScorer implements Scorer {
  id = 'user-feedback'
  name = 'User Feedback'
  type = 'rule' as const

  async score(report: SessionReport): Promise<ScoreResult | null> {
    // feedbacks are loaded from the store, counted via report metadata
    // We read feedback counts from the scores metadata if available,
    // but the primary way is to count from the telemetry store
    // For the scorer, we receive feedback data via the report's custom metadata
    const meta = report as unknown as {
      _feedbackPositive?: number
      _feedbackNegative?: number
      _starRatings?: number[] // array of 1-5 values
    }

    const positive = meta._feedbackPositive ?? 0
    const negative = meta._feedbackNegative ?? 0
    const thumbsTotal = positive + negative
    const starRatings = meta._starRatings ?? []

    // Need at least one signal (thumbs or stars)
    if (thumbsTotal === 0 && starRatings.length === 0) return null

    // Compute thumbs score (0-1)
    const thumbsScore = thumbsTotal > 0 ? positive / thumbsTotal : null

    // Compute star score normalized to 0-1 (1 star = 0.0, 5 stars = 1.0)
    const starScore = starRatings.length > 0
      ? starRatings.reduce((sum, r) => sum + (r - 1) / 4, 0) / starRatings.length
      : null

    // Blend: if both exist, weight stars more (0.6) since they're more granular
    let score: number
    if (thumbsScore !== null && starScore !== null) {
      score = thumbsScore * 0.4 + starScore * 0.6
    } else if (starScore !== null) {
      score = starScore
    } else {
      score = thumbsScore!
    }

    // Confidence based on total sample size
    const totalSignals = thumbsTotal + starRatings.length
    let confidence = 0.25
    if (totalSignals >= 3) confidence = 0.75
    else if (totalSignals >= 2) confidence = 0.5

    return {
      scorerId: this.id,
      score: Math.round(score * 1000) / 1000,
      confidence,
      reason: `${positive} positive, ${negative} negative thumbs; ${starRatings.length} star ratings (avg ${starRatings.length > 0 ? (starRatings.reduce((a, b) => a + b, 0) / starRatings.length).toFixed(1) : 'N/A'})`,
      metadata: { positive, negative, thumbsTotal, starRatings, starScore, thumbsScore },
      computedAt: Date.now(),
    }
  }
}

// ─── Task Completion Scorer ──────────────────────────────────────────────

export class TaskCompletionScorer implements Scorer {
  id = 'task-completion'
  name = 'Task Completion'
  type = 'rule' as const

  async score(report: SessionReport): Promise<ScoreResult | null> {
    const toolCalls = parseToolCalls(report)

    // no_errors: 1 if toolErrorCount == 0, else 0
    const noErrors = report.tool_error_count === 0 ? 1 : 0

    // tool_success_rate: completed / total (0 if no tools)
    const totalTools = toolCalls.length
    const completedTools = toolCalls.filter((tc) => tc.status === 'completed').length
    const toolSuccessRate = totalTools > 0 ? completedTools / totalTools : 0

    // has_content: 1 if message_count > 0
    const hasContent = report.message_count > 0 ? 1 : 0

    const score = noErrors * 0.5 + toolSuccessRate * 0.3 + hasContent * 0.2

    return {
      scorerId: this.id,
      score: Math.round(score * 100) / 100,
      confidence: 0.6,
      reason: `no_errors=${noErrors}, tool_success=${completedTools}/${totalTools}, has_content=${hasContent}`,
      metadata: { noErrors, toolSuccessRate, hasContent, totalTools, completedTools },
      computedAt: Date.now(),
    }
  }
}

// ─── Tool Efficiency Scorer ──────────────────────────────────────────────

export class ToolEfficiencyScorer implements Scorer {
  id = 'tool-efficiency'
  name = 'Tool Efficiency'
  type = 'rule' as const

  async score(report: SessionReport): Promise<ScoreResult | null> {
    const toolCalls = parseToolCalls(report)

    if (toolCalls.length === 0) return null

    const uniqueNames = new Set(toolCalls.map((tc) => tc.name))
    const score = uniqueNames.size / toolCalls.length

    return {
      scorerId: this.id,
      score: Math.round(score * 100) / 100,
      confidence: 0.5,
      reason: `${uniqueNames.size} unique tools out of ${toolCalls.length} calls`,
      metadata: { uniqueTools: uniqueNames.size, totalCalls: toolCalls.length },
      computedAt: Date.now(),
    }
  }
}
