import type { Message as TeamcluMessage } from "@/lib/proto/teamclu_pb";
import {
  isToolOnlyTurnAnchor,
  mergePendingAgentReplies,
  streamEntryHasVisibleContent,
} from "@/lib/stream/live-agent-stream";
export { dumpInterruptMsgDiag, logInterruptMsgDiag } from "@/lib/diagnostics/interrupt-msg-diag-core";
import { snapshotTranscriptParts } from "@/lib/stream/streaming-persist";
import {
  persistedPartsCoverLiveArtifacts,
  type AgentStreamEntry,
  type ArchivedEntry,
} from "@/stores/v2-streaming-store";
import { summarizeToolCallsForDiag } from "@/lib/diagnostics/stream-tool-diag";

export function summarizeStreamEntry(
  entry: AgentStreamEntry | ArchivedEntry | undefined,
  label = "stream",
): Record<string, unknown> {
  if (!entry) return { [label]: null };
  const parts = snapshotTranscriptParts(entry);
  return {
    [`${label}Source`]: "archiveId" in entry ? "archived" : "byKey",
    [`${label}StreamId`]: entry.streamId,
    [`${label}Active`]: entry.active,
    [`${label}ToolCalls`]: summarizeToolCallsForDiag(entry.toolCalls),
    [`${label}PartTypes`]: parts.map((part) => part.type),
    [`${label}LastUpdate`]: entry.lastUpdate,
    [`${label}HasVisible`]: streamEntryHasVisibleContent(entry),
  };
}

export function summarizePendingReplies(
  pending: TeamcluMessage[] | undefined,
): Record<string, unknown> {
  const rows = pending ?? [];
  return {
    pendingCount: rows.length,
    pendingIds: rows.map((row) => row.messageId),
    pendingTurnIds: rows.map((row) => row.turnId || ""),
    pendingContentLengths: rows.map((row) => (row.content ?? "").trim().length),
  };
}

export function summarizeFlushDecision(args: {
  pending: TeamcluMessage[];
  liveStream?: AgentStreamEntry;
  resolvedStream?: AgentStreamEntry;
}): Record<string, unknown> {
  const merged = mergePendingAgentReplies(args.pending, args.resolvedStream);
  const toolOnlyAnchor = isToolOnlyTurnAnchor(args.pending, args.resolvedStream);
  const parts = snapshotTranscriptParts(args.resolvedStream);
  return {
    ...summarizePendingReplies(args.pending),
    ...summarizeStreamEntry(args.liveStream, "live"),
    ...summarizeStreamEntry(args.resolvedStream, "resolved"),
    merged: merged
      ? {
          messageId: merged.messageId,
          turnId: merged.turnId,
          contentLength: (merged.content ?? "").trim().length,
        }
      : null,
    toolOnlyAnchor,
    resolvedPartCount: parts.length,
    resolvedHasTools: parts.some((part) => part.type === "tool-call"),
  };
}

export function summarizePersistRelease(args: {
  persistedPartsJson?: string;
}): Record<string, unknown> {
  const json = args.persistedPartsJson ?? "";
  let partTypes: string[] = [];
  try {
    const parts = JSON.parse(json) as Array<{ type?: string }>;
    if (Array.isArray(parts)) partTypes = parts.map((part) => part.type ?? "?");
  } catch {
    partTypes = ["parse-error"];
  }
  return {
    partsJsonLength: json.length,
    partsJsonPartTypes: partTypes,
    skipArchive: persistedPartsCoverLiveArtifacts(json),
  };
}
