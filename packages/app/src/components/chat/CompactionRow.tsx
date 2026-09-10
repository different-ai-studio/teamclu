import * as React from "react";
import { Loader2, ScrollText } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MessagePart } from "@/stores/session-types";
import {
  compactionReasonLabel,
  formatCompactionDurationMs,
  formatCompactionTokenLine,
} from "@/lib/stream/compaction-display";

export const CompactionRow = React.memo(function CompactionRow({
  part,
}: {
  part: MessagePart;
}) {
  const { t } = useTranslation();
  const completed = part.completed !== false;
  const reason = compactionReasonLabel(t, part.reason);
  const duration = formatCompactionDurationMs(t, part.durationMs);
  const meta = completed
    ? duration
      ? t("chat.compaction.completedMeta", "ok · {{duration}}", { duration })
      : t("chat.compaction.completedShort", "ok")
    : t("chat.compaction.inProgressMeta", "{{reason}} · in progress", { reason });
  const bottom = completed
    ? formatCompactionTokenLine(t, part) ??
      t("chat.compaction.title", "Context automatically compacted")
    : t("chat.compaction.inProgressTitle", "Compacting context automatically...");

  return (
    <div
      className="overflow-hidden rounded-lg border border-border-soft bg-paper font-mono text-[11.5px]"
      data-testid="compaction-row"
      data-compaction-status={completed ? "completed" : "in_progress"}
    >
      <div className="flex items-center gap-1.5 border-b border-border-soft bg-[#fbf9f4] px-2.5 py-1.5 text-ink-2">
        <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted-foreground">
          {completed ? (
            <ScrollText className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          )}
        </span>
        <span className="text-ink-2">
          {t("chat.compaction.label", "compact")}
        </span>
        <span className="ml-auto text-[11px] text-faint">{meta}</span>
      </div>
      <div className="truncate px-2.5 py-1.5 text-[11px] text-muted-foreground">
        {bottom}
      </div>
    </div>
  );
});
