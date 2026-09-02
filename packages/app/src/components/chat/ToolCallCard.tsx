import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronRight,
  ListChecks,
  Search,
  Terminal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ToolCall } from "@/stores/session";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { getCommandText, getToolCallOutputText } from "@/lib/terminal-interaction";

// Import sub-cards and utilities from tool-calls/
import { ToolCallStatusGlyph } from "./tool-calls/ToolCallStatusGlyph";
import { ToolCallDisclosure } from "./tool-calls/ToolCallDisclosure";
import { WriteToolCard } from "./tool-calls/WriteToolCard";
import { EditToolCard } from "./tool-calls/EditToolCard";
import { ReadToolCard } from "./tool-calls/ReadToolCard";
import { RoleLoadToolCard } from "./tool-calls/RoleLoadToolCard";
import { PageNavLinksToolCard } from "./tool-calls/PageNavLinksToolCard";
import { QuestionCard } from "./QuestionCard";
import { QuestionToolIndicator } from "./tool-calls/QuestionToolIndicator";
import { RoleSkillToolCard, ManageSkillsToolCard, SkillToolCard, TaskToolCard } from "./tool-calls/TaskToolCard";
import {
  getStatusConfig,
  getToolIconByKind,
  matchesQuestionTool,
  matchesWriteTool,
  matchesEditTool,
  matchesReadTool,
  matchesTaskTool,
  matchesSkillTool,
  matchesManageSkillsTool,
  matchesRoleSkillTool,
  matchesRoleLoadTool,
  matchesShowPageNavLinksTool,
  matchesCommandTool,
  matchesTodoTool,
  displayToolName,
  formatToolName,
} from "./tool-calls/tool-call-utils";

interface ToolCallCardProps {
  toolCall: ToolCall;
  onOpenDetail?: (
    type: "search" | "file" | "terminal" | "mcp",
    data: unknown,
  ) => void;
  /** Question tool: full card vs compact row (live dock while answering below). */
  questionPresentation?: "full" | "indicator";
}

export const ToolCallCard = React.memo(function ToolCallCard({
  toolCall,
  onOpenDetail,
  questionPresentation = "full",
}: ToolCallCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const config = getStatusConfig((key, fallback, options) =>
    t(key, { defaultValue: fallback, ...options }),
  )[toolCall.status];
  const StatusIcon = config.icon;
  const isCommand = matchesCommandTool(toolCall);
  const commandText = getCommandText(toolCall.arguments);
  const commandOutput = getToolCallOutputText(toolCall.result, toolCall.arguments).trim();
  const commandDescription = (() => {
    const args = toolCall.arguments as Record<string, unknown> | undefined;
    const rawOutput =
      toolCall.rawOutput && typeof toolCall.rawOutput === "object"
        ? (toolCall.rawOutput as Record<string, unknown>)
        : undefined;
    const rawOutputTitle =
      typeof rawOutput?.title === "string" ? rawOutput.title.trim() : "";
    const wireName = toolCall.name.trim();
    const genericWireNames = new Set([
      "bash",
      "shell",
      "terminal",
      "execute",
      "command",
      "unknown",
    ]);
    const preferred =
      (typeof args?._description === "string" ? args._description : null) ||
      (typeof args?.description === "string" ? args.description : null) ||
      (typeof args?.summary === "string" ? args.summary : null) ||
      (typeof args?.title === "string" ? args.title : null) ||
      (typeof args?.action === "string" ? args.action : null);
    return (
      preferred?.trim() ||
      rawOutputTitle ||
      (!genericWireNames.has(wireName.toLowerCase()) ? wireName : "") ||
      commandText.trim() ||
      t("chat.toolCall.command.defaultDescription", "Execute command")
    );
  })();

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const getDetailType = (
    toolName: string,
  ): "search" | "file" | "terminal" | "mcp" => {
    const name = toolName.toLowerCase();
    if (name.includes("search") || name.includes("web")) return "search";
    if (
      name.includes("file") ||
      name.includes("read") ||
      name.includes("write")
    )
      return "file";
    if (name.includes("bash") || name.includes("shell")) return "terminal";
    return "mcp";
  };

  // Extract a brief summary from arguments
  const getSummary = (): string | null => {
    const args = toolCall.arguments;
    if (!args) return null;

    // Try common argument names
    if (typeof args === "object") {
      const summary =
        (args as Record<string, unknown>).path ||
        (args as Record<string, unknown>).command ||
        (args as Record<string, unknown>).query ||
        (args as Record<string, unknown>).url ||
        (args as Record<string, unknown>).pattern;
      if (typeof summary === "string") {
        return summary.length > 60 ? summary.slice(0, 60) + "..." : summary;
      }
    }
    return null;
  };

  const summary = getSummary();
  const routeName = displayToolName(toolCall);

  // opencode `question` tool → interactive QuestionCard (options + custom
  // answer), fed by the `question_asked` raw acp event (pendingQuestions).
  if (routeName === "question") {
    if (questionPresentation === "indicator") {
      return <QuestionToolIndicator toolCall={toolCall} />;
    }
    const args = toolCall.arguments as { questions?: unknown } | undefined;
    const questions =
      (Array.isArray(toolCall.questions) ? toolCall.questions : undefined) ??
      args?.questions;
    return (
      <QuestionCard
        toolCallId={toolCall.id}
        questions={questions}
        isCompleted={toolCall.status === "completed"}
      />
    );
  }
  const compactToolName = routeName.toLowerCase();
  const isTodo = matchesTodoTool(toolCall);
  const isCompactSearchTool =
    routeName === "grep" ||
    routeName === "glob" ||
    routeName === "find";

  const renderExpandableHeaderSlot = (icon: React.ReactNode, testId?: string) => (
    <span className="relative h-[22px] w-[22px] shrink-0" aria-hidden="true">
      <span
        data-testid={testId}
        className="absolute inset-0 flex items-center justify-center group-hover:opacity-0"
      >
        {icon}
      </span>
      <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100">
        <ChevronRight
          size={13}
          className={cn(
            "text-[#64748b] transition-transform duration-200 dark:text-muted-foreground",
            expanded && "rotate-90",
          )}
        />
      </span>
    </span>
  );

  const getCompactTitle = () => {
    const route = routeName;
    if (route === "grep") return t("chat.toolCall.search.grep", "Grep");
    if (route === "glob") return t("chat.toolCall.search.glob", "Glob");
    if (route === "find") return t("chat.toolCall.search.find", "Find");
    if (isTodo) return t("chat.toolCall.todo.title", "Todo");
    return formatToolName((key, fallback, options) => t(key, { defaultValue: fallback, ...options }), routeName);
  };

  const parseTodoSummary = () => {
    if (!isTodo || typeof toolCall.result !== "string" || !toolCall.result.trim()) {
      return null;
    }

    try {
      const parsed = JSON.parse(toolCall.result) as Array<{ status?: string }>;
      if (!Array.isArray(parsed)) return null;

      const total = parsed.length;
      const inProgress = parsed.filter((item) => item?.status === "in_progress").length;
      const completed = parsed.filter((item) => item?.status === "completed").length;

      return {
        primary: t("chat.toolCall.todo.itemsUpdated", "{{count}} items updated", { count: total }),
        meta:
          inProgress > 0
            ? t("chat.toolCall.todo.inProgressCount", "{{count}} in progress", { count: inProgress })
            : completed === total && total > 0
              ? t("chat.toolCall.todo.allDone", "all done")
              : null,
      };
    } catch {
      return null;
    }
  };

  const todoSummary = parseTodoSummary();
  const commandStatusText =
    toolCall.status === "failed"
      ? t("chat.toolCall.status.failed", "Failed")
      : toolCall.status === "waiting"
        ? t("chat.toolCall.status.waiting", "Waiting")
        : null;

  const getCompactPrimary = () => {
    if (isCompactSearchTool) {
      return summary || "";
    }

    if (isTodo) {
      if (todoSummary) {
        return todoSummary.primary;
      }
      const text = typeof toolCall.result === "string" ? toolCall.result : summary || "";
      return text.split("·")[0]?.trim() || t("chat.toolCall.todo.itemsUpdatedFallback", "items updated");
    }
    return summary || "";
  };

  const getCompactMeta = () => {
    if (isCompactSearchTool) {
      return null;
    }

    if (
      isTodo &&
      todoSummary
    ) {
      return todoSummary.meta;
    }

    if (
      isTodo &&
      typeof toolCall.result === "string" &&
      toolCall.result &&
      toolCall.result.includes("·")
    ) {
      return toolCall.result.split("·").slice(1).join("·").trim();
    }
    return null;
  };

  // If this is a Write tool, render WriteToolCard
  if (matchesWriteTool(toolCall)) {
    return <WriteToolCard toolCall={toolCall} />;
  }

  // If this is an Edit tool, render EditToolCard
  if (matchesEditTool(toolCall)) {
    return <EditToolCard toolCall={toolCall} />;
  }

  // If this is a Read tool, render minimal ReadToolCard
  if (matchesReadTool(toolCall)) {
    return <ReadToolCard toolCall={toolCall} />;
  }

  if (matchesShowPageNavLinksTool(toolCall)) {
    return <PageNavLinksToolCard toolCall={toolCall} />;
  }

  // If this is a manage_skills tool, render ManageSkillsToolCard
  if (matchesManageSkillsTool(toolCall)) {
    return <ManageSkillsToolCard toolCall={toolCall} />;
  }

  // If this is a Skill tool, render SkillToolCard
  if (matchesSkillTool(toolCall)) {
    return <SkillToolCard toolCall={toolCall} />;
  }

  if (matchesRoleSkillTool(toolCall)) {
    return <RoleSkillToolCard toolCall={toolCall} />;
  }

  if (matchesRoleLoadTool(toolCall)) {
    return <RoleLoadToolCard toolCall={toolCall} />;
  }

  // If this is a Task tool (subagent), render TaskToolCard
  if (matchesTaskTool(toolCall)) {
    return <TaskToolCard toolCall={toolCall} />;
  }

  if (matchesQuestionTool(toolCall)) {
    return <QuestionToolIndicator toolCall={toolCall} />;
  }

  if (isCommand) {
    return (
      <ToolCallDisclosure
        testId="tool-card-bash"
        contentTestId="tool-card-bash-output"
        icon={<Terminal className="h-3.5 w-3.5" />}
        title={t("chat.toolCall.command.title", "Bash")}
        target={commandDescription}
        meta={
          <>
            {commandStatusText ? <span>{commandStatusText}</span> : null}
            {toolCall.duration ? <span>{formatDuration(toolCall.duration)}</span> : null}
          </>
        }
        status={<ToolCallStatusGlyph status={toolCall.status} />}
      >
        <div className="max-h-[280px] overflow-auto bg-background/60 font-mono">
          <div className="flex items-start gap-2 border-b border-border-soft px-3 py-2 text-[11.5px] leading-5 text-ink-2">
            <span className="shrink-0 text-faint">$</span>
            <pre className="min-w-0 whitespace-pre-wrap break-words">{commandText}</pre>
          </div>
          <pre className="whitespace-pre-wrap break-words px-3 py-2.5 text-[11.5px] leading-[1.65] text-ink-2">
            {commandOutput || t("chat.toolCall.command.noOutput", "No output")}
          </pre>
        </div>
      </ToolCallDisclosure>
    )
  }

  if (isCompactSearchTool || isTodo) {
    const rowTestId = `tool-row-${compactToolName.includes("grep") ? "grep" : compactToolName === "glob" ? "glob" : compactToolName.includes("bash") ? "bash" : compactToolName === "role_skill" ? "role-skill" : compactToolName}`
    const primaryText = getCompactPrimary()
    const metaText = getCompactMeta()
    const compactResult = typeof toolCall.result === "string" ? toolCall.result : ""
    const todoItems = isTodo
      ? (() => {
          try {
            const parsed = JSON.parse(compactResult) as Array<{ content?: string; text?: string; status?: string }>
            return Array.isArray(parsed) ? parsed : []
          } catch {
            return []
          }
        })()
      : []

    return (
      <ToolCallDisclosure
        testId={rowTestId}
        icon={isTodo ? <ListChecks className="h-3.5 w-3.5" /> : <Search className="h-3.5 w-3.5" />}
        title={getCompactTitle()}
        target={primaryText}
        meta={metaText}
        status={<ToolCallStatusGlyph status={toolCall.status} />}
      >
        {isTodo && todoItems.length > 0 ? (
          <div className="space-y-1 px-3 py-2.5">
            {todoItems.map((item, index) => (
              <div key={index} className="flex min-h-6 items-center gap-2 text-[11.5px] text-ink-2">
                <span
                  className={cn(
                    "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border border-faint text-[9px]",
                    item.status === "completed" && "border-green-600 bg-green-600 text-white",
                  )}
                >
                  {item.status === "completed" ? "✓" : ""}
                </span>
                <span>{item.content || item.text || `${index + 1}`}</span>
              </div>
            ))}
          </div>
        ) : (
          <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words bg-background/60 px-3 py-2.5 font-mono text-[11.5px] leading-[1.65] text-ink-2">
            {compactResult || t("chat.toolCall.noDetails", "No details available")}
          </pre>
        )}
      </ToolCallDisclosure>
    )
  }

  const fallbackArgCount = toolCall.arguments ? Object.keys(toolCall.arguments).length : 0;
  const fallbackSummary =
    summary ||
    (typeof toolCall.arguments === "object" && toolCall.arguments
      ? (["description", "title", "action", "query", "url"] as const)
          .map((key) => toolCall.arguments?.[key])
          .find((value): value is string => typeof value === "string" && value.trim().length > 0)
      : null) ||
    null;

  if (routeName !== "think") {
    const KindIcon = getToolIconByKind(toolCall.toolKind);
    let resultContent = toolCall.result;

    if (resultContent && typeof resultContent === "object") {
      const resultObj = resultContent as Record<string, unknown>;
      if (Array.isArray(resultObj.content)) {
        const textParts = resultObj.content
          .filter(
            (item: unknown) =>
              item &&
              typeof item === "object" &&
              (item as Record<string, unknown>).type === "text",
          )
          .map((item: unknown) => (item as Record<string, unknown>).text)
          .join("\n");
        if (textParts) resultContent = textParts;
      } else if (resultObj.text) {
        resultContent = resultObj.text;
      } else if (resultObj.output) {
        resultContent = resultObj.output;
      }
    }

    const displayResult =
      resultContent === undefined || resultContent === null
        ? null
        : typeof resultContent === "string"
          ? resultContent.slice(0, 500) + (resultContent.length > 500 ? "..." : "")
          : JSON.stringify(resultContent, null, 2);

    return (
      <ToolCallDisclosure
        testId="tool-fallback"
        icon={
          <span data-testid="tool-fallback-icon">
            <KindIcon className="h-3.5 w-3.5" />
          </span>
        }
        title={formatToolName(
          (key, fallback, options) => t(key, { defaultValue: fallback, ...options }),
          routeName,
        )}
        target={fallbackSummary || undefined}
        meta={
          <>
            {fallbackArgCount > 0 ? (
              <span>{t("chat.toolCall.argCount", "{{count}} args", { count: fallbackArgCount })}</span>
            ) : null}
            {toolCall.duration ? <span>{formatDuration(toolCall.duration)}</span> : null}
          </>
        }
        status={<ToolCallStatusGlyph status={toolCall.status} />}
      >
        <div className="divide-y divide-border-soft">
          {toolCall.arguments && Object.keys(toolCall.arguments).length > 0 ? (
            <div className="grid grid-cols-[88px_minmax(0,1fr)] font-mono text-[10.5px]">
              <span className="bg-background/70 px-2.5 py-2 text-faint">
                {t("chat.toolCall.arguments", "Arguments")}
              </span>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words px-2.5 py-2 text-ink-2">
                {JSON.stringify(toolCall.arguments, null, 2)}
              </pre>
            </div>
          ) : null}
          {displayResult !== null ? (
            <div className="grid grid-cols-[88px_minmax(0,1fr)] font-mono text-[10.5px]">
              <span className="bg-background/70 px-2.5 py-2 text-faint">
                {toolCall.status === "failed"
                  ? t("chat.toolCall.error", "Error")
                  : t("chat.toolCall.result", "Result")}
              </span>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 text-ink-2">
                {displayResult}
              </pre>
            </div>
          ) : null}
          {fallbackArgCount === 0 && displayResult === null ? (
            <div className="px-3 py-2.5 text-[11.5px] italic text-muted-foreground">
              {t("chat.toolCall.noDetails", "No details available")}
            </div>
          ) : null}
          {onOpenDetail ? (
            <div className="px-3 py-2">
              <button
                type="button"
                onClick={() => onOpenDetail(getDetailType(routeName), toolCall)}
                className="text-[10.5px] text-muted-foreground underline underline-offset-2"
              >
                {t("chat.toolCall.viewFullDetails", "View full details")} →
              </button>
            </div>
          ) : null}
        </div>
      </ToolCallDisclosure>
    );
  }

  return (
    <div className="space-y-2">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <div className="overflow-hidden rounded-[16px] border border-[#e7edf4] bg-[#fbfcfe] transition-all duration-200 dark:border-border dark:bg-card">
          <CollapsibleTrigger asChild>
            <button className="group w-full flex items-center gap-[10px] px-[12px] py-[10px] text-left transition-colors hover:bg-[#f4f7fa] dark:hover:bg-muted/30">
              {renderExpandableHeaderSlot(
                (() => {
                  const KindIcon = getToolIconByKind(toolCall.toolKind);
                  return (
                    <span
                      data-testid="tool-fallback-icon"
                      className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[8px] border border-[#e2e8f0] bg-[#f8fafc] dark:border-border dark:bg-muted/20"
                      aria-hidden="true"
                    >
                      <KindIcon size={12} className="text-[#475569] dark:text-slate-400" />
                    </span>
                  );
                })(),
                "tool-fallback-icon",
              )}
              <span className="min-w-0 flex-1 text-[13px] font-medium text-[#1f2933] dark:text-foreground">
                {formatToolName((key, fallback, options) => t(key, { defaultValue: fallback, ...options }), routeName)}
              </span>
              {!expanded && fallbackSummary && (
                <span className="max-w-[18rem] truncate text-[11px] text-[#64748b] dark:text-muted-foreground">
                  {fallbackSummary}
                </span>
              )}
              <div className="ml-auto flex items-center gap-2">
                {fallbackArgCount > 0 && (
                  <span className="rounded-full border border-[#e2e8f0] bg-[#f8fafc] px-[6px] py-[1px] text-[10px] text-[#64748b] dark:border-border dark:bg-muted/20 dark:text-muted-foreground">
                    {t("chat.toolCall.argCount", "{{count}} args", { count: fallbackArgCount })}
                  </span>
                )}
                {toolCall.duration && (
                  <span className="text-[10px] text-[#94a3b8] dark:text-muted-foreground/70">
                    {formatDuration(toolCall.duration)}
                  </span>
                )}
                <StatusIcon
                  size={13}
                  className={cn(
                    config.textColor,
                    config.animate && "animate-spin",
                  )}
                />
              </div>
            </button>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <div className="space-y-2 border-t border-[#eef2f5] bg-white/80 px-[12px] pb-3 pt-2 text-xs dark:border-border/60 dark:bg-background/40">
              {toolCall.arguments &&
                Object.keys(toolCall.arguments).length > 0 && (
                  <div>
                    <span className="text-muted-foreground font-medium">
                      {t("chat.toolCall.arguments", "Arguments")}
                    </span>
                    <pre className="mt-1 p-2 bg-background/60 rounded text-[10px] overflow-x-auto font-mono max-h-24">
                      {JSON.stringify(toolCall.arguments, null, 2)}
                    </pre>
                  </div>
                )}

              {(() => {
                let resultContent = toolCall.result;

                if (resultContent && typeof resultContent === "object") {
                  const resultObj = resultContent as Record<string, unknown>;
                  if (Array.isArray(resultObj.content)) {
                    const textParts = resultObj.content
                      .filter(
                        (c: unknown) =>
                          c &&
                          typeof c === "object" &&
                          (c as Record<string, unknown>).type === "text",
                      )
                      .map((c: unknown) => (c as Record<string, unknown>).text)
                      .join("\n");
                    if (textParts) resultContent = textParts;
                  } else if (resultObj.text) {
                    resultContent = resultObj.text;
                  } else if (resultObj.output) {
                    resultContent = resultObj.output;
                  }
                }

                if (resultContent !== undefined && resultContent !== null) {
                  const displayText =
                    typeof resultContent === "string"
                      ? resultContent.slice(0, 500) +
                        (resultContent.length > 500 ? "..." : "")
                      : JSON.stringify(resultContent, null, 2);

                  return (
                    <div>
                      <span className="text-muted-foreground font-medium">
                        {t("chat.toolCall.result", "Result")}
                      </span>
                      <pre className="mt-1 p-2 bg-background/60 rounded text-[10px] overflow-x-auto max-h-48 font-mono whitespace-pre-wrap">
                        {displayText}
                      </pre>
                    </div>
                  );
                }
                return null;
              })()}

              {(!toolCall.arguments ||
                Object.keys(toolCall.arguments).length === 0) &&
                (toolCall.result === undefined || toolCall.result === null) && (
                  <div className="text-muted-foreground/60 italic py-2">
                    {t("chat.toolCall.noDetails", "No details available")}
                  </div>
                )}

              {onOpenDetail && (
                <button
                  onClick={() =>
                    onOpenDetail(getDetailType(routeName), toolCall)
                  }
                  className="text-[10px] text-muted-foreground hover:text-foreground hover:underline"
                >
                  {t("chat.toolCall.viewFullDetails", "View full details")} →
                </button>
              )}
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>

    </div>
  );
});
