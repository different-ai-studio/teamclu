import type { ToolCall } from "@/stores/session-types";
import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";
import { ToolCallStatusGlyph } from "./ToolCallStatusGlyph";
import { ToolCallDisclosure } from "./ToolCallDisclosure";

function getRoleName(toolCall: ToolCall, fallback: string): string {
  const args = toolCall.arguments as Record<string, unknown> | undefined;
  const rawName = args?.name ?? args?.role;
  return typeof rawName === "string" && rawName.trim() ? rawName.trim() : fallback;
}

function getLoadedSkillCount(result: unknown): number {
  if (typeof result !== "string") return 0;
  const match = result.match(/## Role Skills([\s\S]*)$/);
  if (!match) return 0;
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s+/.test(line)).length;
}

function getContextPreview(result: unknown): string | null {
  if (typeof result !== "string") return null;
  const descriptionMatch = result.match(/Description:\s*(.+)/);
  if (descriptionMatch?.[1]) return descriptionMatch[1].trim();
  const line = result
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith("#"));
  return line || null;
}

function renderContextWithCodePill(context: string) {
  const tokenPattern = /([a-z0-9]+(?:[_-][a-z0-9]+){2,})/gi;
  const matches = Array.from(context.matchAll(tokenPattern));

  if (matches.length === 0) {
    return <span className="break-words">{context}</span>;
  }

  const firstMatch = matches[0];
  const matchText = firstMatch[0];
  const start = firstMatch.index ?? 0;
  const end = start + matchText.length;

  return (
    <span className="break-words">
      {context.slice(0, start)}
      <code className="rounded-md border border-[#e5eaf0] bg-[#f8fafc] px-[5px] py-[1px] text-[11px] text-[#334155] dark:border-border dark:bg-background dark:text-foreground/85">
        {matchText}
      </code>
      {context.slice(end)}
    </span>
  );
}

export function RoleLoadToolCard({ toolCall }: { toolCall: ToolCall }) {
  const { t } = useTranslation();
  const roleName = getRoleName(toolCall, "unnamed-role");
  const skillCount = getLoadedSkillCount(toolCall.result);
  const context = getContextPreview(toolCall.result);

  let readyText = t("chat.toolCall.roleLoad.instructionsReady", "role instructions ready");
  if (skillCount > 0) {
    readyText = t(
      "chat.toolCall.roleLoad.instructionsAndSkills",
      "role instructions + {{count}} role skills",
      { count: skillCount },
    );
  }

  return (
    <ToolCallDisclosure
      testId="tool-card-role-load"
      icon={<Sparkles className="h-3.5 w-3.5" />}
      title={t("chat.toolCall.roleLoad.title", "Role Load")}
      target={roleName}
      status={<ToolCallStatusGlyph status={toolCall.status} />}
    >
      <div className="grid grid-cols-[85px_1fr] gap-x-3 gap-y-2 px-3 py-2.5 text-[11.5px]">
        <div className="text-faint">
          {t("chat.toolCall.roleLoad.ready", "Ready")}
        </div>
        <div className="text-ink-2">{readyText}</div>
        <div className="text-faint">
          {t("chat.toolCall.roleLoad.context", "Context")}
        </div>
        <div className="min-w-0 text-ink-2">
          {context ? (
            renderContextWithCodePill(context)
          ) : (
            <span className="text-muted-foreground">
              {t("chat.toolCall.roleLoad.noAdditionalContext", "No additional context")}
            </span>
          )}
        </div>
      </div>
    </ToolCallDisclosure>
  );
}
