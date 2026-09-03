import { cn } from "@/lib/utils";
import type { ToolCall } from "@/stores/session-types";

export function ToolCallStatusGlyph({
  status,
  className,
}: {
  status: ToolCall["status"];
  className?: string;
}) {
  if (status === "completed") {
    return (
      <span className={cn("text-[13px] text-green-600 dark:text-green-400", className)}>
        ✓
      </span>
    );
  }

  if (status === "failed") {
    return (
      <span className={cn("text-[13px] text-red-600 dark:text-red-400", className)}>
        ✕
      </span>
    );
  }

  return (
    <span
      aria-label={status === "waiting" ? "Waiting" : "Running"}
      data-testid="tool-call-breathing-status"
      role="status"
      className={cn("relative inline-flex h-3 w-3 items-center justify-center", className)}
    >
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/40 opacity-75 dark:bg-emerald-400/40" />
      <span className="relative inline-flex h-2 w-2 animate-pulse rounded-full bg-emerald-500 ring-2 ring-emerald-500/20 dark:bg-emerald-400 dark:ring-emerald-400/20" />
    </span>
  );
}
