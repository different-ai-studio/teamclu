import type { TFunction } from "i18next";
import type { MessagePart } from "@/stores/session-types";

export function compactionReasonLabel(
  t: TFunction,
  reason: string | undefined,
): string {
  const key = reason?.trim() || "threshold";
  return t(`chat.compaction.reason.${key}`, key);
}

export function formatCompactionDurationMs(
  t: TFunction,
  durationMs: number | undefined,
): string | undefined {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) {
    return undefined;
  }
  if (durationMs < 1000) {
    return t("chat.compaction.durationMs", "{{ms}}ms", {
      ms: Math.round(durationMs),
    });
  }
  return t("chat.compaction.durationSec", "{{sec}}s", {
    sec: (durationMs / 1000).toFixed(1),
  });
}

export function formatCompactionTokenLine(
  t: TFunction,
  part: MessagePart,
): string | undefined {
  const before = part.tokensBefore;
  const after = part.tokensAfter;
  if (before == null && after == null) return undefined;
  const reason = compactionReasonLabel(t, part.reason);
  const beforeText =
    before != null
      ? t("chat.compaction.tokenCount", "{{count, number}}", { count: before })
      : "?";
  const afterText =
    after != null
      ? t("chat.compaction.tokenCountApprox", "~{{count, number}}", {
          count: after,
        })
      : "?";
  return t("chat.compaction.tokenChange", "{{before}} → {{after}} tokens · {{reason}}", {
    before: beforeText,
    after: afterText,
    reason,
  });
}

export function formatAgentProcessSummary(
  t: TFunction,
  meta: {
    toolCount: number;
    hasThinking: boolean;
    compactionCount?: number;
  },
): string | undefined {
  const bits: string[] = [];
  if (meta.hasThinking) {
    bits.push(t("chat.processSummary.thinking", "Thinking"));
  }
  if (meta.toolCount > 0) {
    bits.push(
      t("chat.processSummary.tools", "{{count}} tool", { count: meta.toolCount }),
    );
  }
  const compactionCount = meta.compactionCount ?? 0;
  if (compactionCount > 0) {
    bits.push(
      t("chat.processSummary.compacts", "{{count}} compact", {
        count: compactionCount,
      }),
    );
  }
  return bits.join(" · ") || undefined;
}

export function countCompactionParts(parts: MessagePart[]): number {
  return parts.filter((part) => part.type === "compaction").length;
}

/** Merge persisted process parts with live-only compaction rows in timeline order. */
export function mergeProcessPartsWithCompaction(
  processParts: MessagePart[],
  compactionParts: MessagePart[],
): MessagePart[] {
  if (compactionParts.length === 0) return processParts;
  if (processParts.length === 0) return compactionParts;
  const merged = [...processParts];
  for (const compaction of compactionParts) {
    const at = compaction.startedAt ?? 0;
    let insertAt = merged.length;
    for (let i = 0; i < merged.length; i += 1) {
      const candidate = merged[i];
      const candidateAt = candidate?.startedAt ?? 0;
      if (candidateAt > at) {
        insertAt = i;
        break;
      }
    }
    merged.splice(insertAt, 0, compaction);
  }
  return merged;
}
