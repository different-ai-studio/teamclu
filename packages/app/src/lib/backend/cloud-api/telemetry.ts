import type { TelemetryBackend, TelemetryFeedbackDeleteInput } from "@/lib/backend/types";
import type { CloudApiClient } from "@/lib/backend/cloud-api/http";

export function createTelemetryModule(client: CloudApiClient): TelemetryBackend {
  return {
    async insertFeedback(input) {
      await client.post<void>("/v1/feedback", input);
    },
    async deleteFeedback(input: TelemetryFeedbackDeleteInput) {
      const messageId = encodeURIComponent(String(input.messageId));
      const query = input.actorId ? `?actorId=${encodeURIComponent(input.actorId)}` : "";
      await client.delete<void>(`/v1/feedback/${messageId}${query}`);
    },
    async listFeedbacks(input) {
      const out = await client.get<{ items: Array<Record<string, unknown>> }>(
        `/v1/feedback?sessionId=${encodeURIComponent(input.sessionId)}`,
      );
      return out.items;
    },
    async listFeedbackSummary(teamId) {
      const out = await client.get<{ items: Array<Record<string, unknown>> }>(
        `/v1/feedback-summary?teamId=${encodeURIComponent(teamId)}`,
      );
      return out.items;
    },
    async insertSessionReport(input) {
      await client.post<void>("/v1/session-report", input);
    },
    async insertSkillUsage(input) {
      await client.post<void>("/v1/skill-usage", input);
    },
    async listLeaderboard(teamId, period = "week") {
      const out = await client.get<{ items: Array<Record<string, unknown>> }>(
        `/v1/teams/${encodeURIComponent(teamId)}/leaderboard?period=${encodeURIComponent(period)}`,
      );
      return out.items;
    },
    async reportClientVersion(teamId, payload) {
      try {
        await client.post<void>(`/v1/teams/${encodeURIComponent(teamId)}/client-version`, payload);
      } catch {
        // ops telemetry only — never block startup
      }
    },
  };
}
