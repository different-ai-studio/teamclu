import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DiffLine } from "@/components/diff/diff-ast";

/** Default visible rows before tail fold (collapsed preview height). */
const DEFAULT_PREVIEW_LINES = 6;

function DiffLineRow({ line, variant }: { line: DiffLine; variant: "viewer" | "snippet" }) {
  if (variant === "snippet") {
    const displayLineNumber = line.newLineNumber ?? line.oldLineNumber ?? "";

    return (
      <div className="grid min-w-full w-max grid-cols-[42px_1fr] font-mono text-[11px] leading-5">
        <span className="select-none border-r border-[#eef2f5] bg-[#fafbfd] px-[10px] py-[6px] text-right text-[10px] text-[#94a3b8] dark:border-border/60 dark:bg-background/60 dark:text-muted-foreground">
          {displayLineNumber}
        </span>
        <span
          className={cn(
            "whitespace-pre px-[10px] py-[6px] text-foreground/90",
            line.type === "added" && "bg-[#f0fdf4] text-[#166534] dark:bg-green-950/20 dark:text-green-300",
            line.type === "removed" && "bg-[#fef2f2] text-[#991b1b] dark:bg-red-950/20 dark:text-red-300",
            line.type === "context" && "bg-[#fcfdff] dark:bg-transparent",
          )}
        >
          {line.type === "added" ? `+ ${line.content}` : line.type === "removed" ? `- ${line.content}` : line.content}
        </span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex min-w-full w-max font-mono text-[11px] leading-5",
        line.type === "added" && "bg-green-500/5 dark:bg-green-500/10",
        line.type === "removed" && "bg-red-500/5 dark:bg-red-500/10",
        line.type === "context" && "bg-transparent",
      )}
    >
      <span className="w-10 text-right pr-2 select-none text-muted-foreground/40 shrink-0 text-[10px]">
        {line.oldLineNumber ?? ""}
      </span>
      <span className="w-10 text-right pr-2 select-none text-muted-foreground/40 shrink-0 text-[10px]">
        {line.newLineNumber ?? ""}
      </span>
      <span
        className={cn(
          "w-4 text-center select-none shrink-0 text-[10px]",
          line.type === "added" && "text-green-600 dark:text-green-500",
          line.type === "removed" && "text-red-600 dark:text-red-500",
          line.type === "context" && "text-muted-foreground/30",
        )}
      >
        {line.type === "added" ? "+" : line.type === "removed" ? "−" : " "}
      </span>
      <span className="whitespace-pre pl-1 pr-3 text-foreground/90">
        {line.content}
      </span>
    </div>
  );
}

interface ToolCallDiffBodyProps {
  lines: DiffLine[];
  /** How many diff rows to show before the tail fold (default 6). */
  previewLineCount?: number;
  variant?: "viewer" | "snippet";
}

/**
 * Diff block for edit/write tool cards: default shows a few lines, bottom chevron expands the rest.
 * Header-level expand/collapse is handled by the parent card.
 */
export function ToolCallDiffBody({
  lines,
  previewLineCount = DEFAULT_PREVIEW_LINES,
  variant = "viewer",
}: ToolCallDiffBodyProps) {
  const { t } = useTranslation();
  const [tailExpanded, setTailExpanded] = useState(false);
  const needsTailToggle = variant === "viewer" && lines.length > previewLineCount;
  const displayed =
    variant === "snippet"
      ? lines
      : !needsTailToggle || tailExpanded
        ? lines
        : lines.slice(0, previewLineCount);
  const collapsedPreview = needsTailToggle && !tailExpanded;

  return (
    <div className="group relative bg-background">
      <div
        className={cn(
          "max-w-full",
          variant === "snippet" && "max-h-[180px] overflow-auto",
          needsTailToggle && tailExpanded
            ? "max-h-[min(400px,70vh)] overflow-auto"
            : "overflow-x-auto",
        )}
      >
        {displayed.map((line, index) => (
          <DiffLineRow key={index} line={line} variant={variant} />
        ))}
      </div>

      {/* Fade hint: more content below (only when tail is collapsed) */}
      {collapsedPreview && (
        <div
          className="pointer-events-none absolute bottom-0 left-0 right-0 z-[1] h-16 bg-gradient-to-t from-background from-25% via-background/55 to-transparent dark:from-background dark:via-background/50"
          aria-hidden
        />
      )}

      {needsTailToggle && (
        <div
          className={cn(
            "relative z-[2] flex justify-center",
            collapsedPreview ? "absolute bottom-0 left-0 right-0" : "border-t border-border/50",
          )}
        >
          <button
            type="button"
            className={cn(
              "flex w-full justify-center outline-none transition-colors",
              "hover:bg-muted/25 focus-visible:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-sm",
              collapsedPreview
                ? "min-h-10 items-end pb-1.5 pt-6"
                : "min-h-0 items-center py-1",
            )}
            onClick={(e) => {
              e.stopPropagation();
              setTailExpanded((v) => !v);
            }}
            aria-expanded={tailExpanded}
            aria-label={
              tailExpanded
                ? t("chat.toolCall.diff.collapsePreview", "Collapse diff preview")
                : t("chat.toolCall.diff.expandFull", "Expand full diff")
            }
          >
            <ChevronDown
              size={16}
              className={cn(
                "shrink-0 text-muted-foreground/90 transition-all duration-200",
                tailExpanded && "opacity-100 rotate-180",
                collapsedPreview &&
                  "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
              )}
            />
          </button>
        </div>
      )}
    </div>
  );
}
