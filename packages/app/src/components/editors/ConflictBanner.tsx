/**
 * ConflictBanner — Shown when agent modifies a file while user has unsaved changes.
 *
 * Provides three actions:
 * - Accept Agent Version: replace editor content with agent's version
 * - Keep Mine: discard external change, next auto-save overwrites disk
 * - View Diff: show a diff view between user and agent content
 */

import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, X, GitCompare } from "lucide-react";
import { cn } from "@/lib/utils";

interface ConflictBannerProps {
  /** Called when user accepts the agent's version */
  onAcceptAgent: () => void;
  /** Called when user keeps their own version */
  onKeepMine: () => void;
  /** Called when user wants to see the diff */
  onViewDiff: () => void;
  /** Whether diff view is currently shown */
  showingDiff?: boolean;
  className?: string;
}

export function ConflictBanner({
  onAcceptAgent,
  onKeepMine,
  onViewDiff,
  showingDiff = false,
  className,
}: ConflictBannerProps) {
  const { t } = useTranslation();

  return (
    <div
      className={cn(
        "flex items-center gap-3 px-3 py-2 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800 text-sm",
        className,
      )}
    >
      <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
      <span className="text-amber-700 dark:text-amber-300 flex-1">
        {t(
          "editor.conflictMessage",
          "Agent modified this file. You have unsaved changes.",
        )}
      </span>
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={onAcceptAgent}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 hover:bg-green-200 dark:hover:bg-green-900/60 transition-colors"
        >
          <Check className="h-3 w-3" />
          {t("editor.acceptAgent", "Accept Agent")}
        </button>
        <button
          onClick={onKeepMine}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
        >
          <X className="h-3 w-3" />
          {t("editor.keepMine", "Keep Mine")}
        </button>
        <button
          onClick={onViewDiff}
          className={cn(
            "inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded transition-colors",
            showingDiff
              ? "bg-blue-200 dark:bg-blue-800 text-blue-700 dark:text-blue-300"
              : "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-900/60",
          )}
        >
          <GitCompare className="h-3 w-3" />
          {t("editor.viewDiff", "View Diff")}
        </button>
      </div>
    </div>
  );
}

export default ConflictBanner;
