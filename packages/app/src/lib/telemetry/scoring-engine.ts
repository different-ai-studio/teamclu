import type { Scorer } from '@/lib/telemetry/scorer'
import type { ScoreResult, SessionReport } from '@/lib/telemetry/types'
import { UserFeedbackScorer, TaskCompletionScorer, ToolEfficiencyScorer } from '@/lib/telemetry/scorer'

export class ScoringEngine {
  private scorers: Scorer[]

  constructor(scorers?: Scorer[]) {
    this.scorers = scorers ?? [
      new UserFeedbackScorer(),
      new TaskCompletionScorer(),
      new ToolEfficiencyScorer(),
    ]
  }

  /**
   * Run all scorers in parallel against a session report.
   * Returns non-null results. Individual scorer failures are logged and skipped.
   */
  async score(report: SessionReport): Promise<ScoreResult[]> {
    const results = await Promise.allSettled(
      this.scorers.map((scorer) => scorer.score(report)),
    )

    const scores: ScoreResult[] = []
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.status === 'fulfilled' && result.value !== null) {
        scores.push(result.value)
      } else if (result.status === 'rejected') {
        console.error(
          `[ScoringEngine] Scorer "${this.scorers[i].id}" failed:`,
          result.reason,
        )
      }
    }

    return scores
  }
}
