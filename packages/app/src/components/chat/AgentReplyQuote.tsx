import * as React from "react";
import { useTranslation } from "react-i18next";
import { CornerDownRight } from "lucide-react";
import { cn } from "@/lib/utils";

export { jumpToMessageById } from "@/lib/ui/chat-scroll-to-message";

/** Soft-strip quote (style B): faint pad + author + inline AGENT pills + body. */
export function AgentReplyQuote({
  authorName,
  content,
  onJump,
  className,
}: {
  authorName: string;
  /** Parent user message content (may include `[Mentioned agents: …]` prefix). */
  content: string;
  onJump: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const { agentNames, body } = React.useMemo(
    () => parseReplyQuoteContent(content),
    [content],
  );

  return (
    <button
      type="button"
      data-testid="agent-reply-quote"
      onClick={onJump}
      className={cn(
        "mb-1.5 flex w-full max-w-[440px] cursor-pointer items-center gap-1.5 rounded-md border-l-2 border-coral/40 bg-[rgba(26,26,20,0.035)] py-[4px] pl-[7px] pr-[9px] text-left transition-colors hover:bg-[rgba(26,26,20,0.06)] dark:bg-white/[0.04] dark:hover:bg-white/[0.07]",
        className,
      )}
    >
      <CornerDownRight className="size-3 shrink-0 text-faint" aria-hidden />
      <span className="shrink-0 whitespace-nowrap text-[10.5px] text-faint">
        {t("chat.replyToPrefix", "回复")}{" "}
        <em className="not-italic font-semibold text-muted-foreground">{authorName}</em>
      </span>
      {agentNames.map((name) => (
        <span
          key={name}
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-coral/10 px-1.5 py-[1px] align-middle whitespace-nowrap"
          data-testid="agent-reply-quote-pill"
        >
          <span className="font-mono text-[8px] font-semibold tracking-[0.04em] text-coral/75 leading-none">
            AGENT
          </span>
          <span className="text-[11px] font-semibold text-coral leading-none">
            {formatAgentAtLabel(name)}
          </span>
        </span>
      ))}
      <span className="min-w-0 flex-1 truncate text-[12.5px] leading-[1.45] text-ink-2 dark:text-[#c8d0d8]">
        {body || (agentNames.length === 0 ? "…" : null)}
      </span>
    </button>
  );
}

function formatAgentAtLabel(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

/** Parse parent content into inline agent pills + body text (no separate mention row). */
export function parseReplyQuoteContent(
  content: string,
  maxBodyLen = 80,
): { agentNames: string[]; body: string } {
  let rest = content.trim();
  const agentNames: string[] = [];

  const agentMatch = rest.match(/^\[Mentioned agents: ([^\]]+)\](?:\r?\n)?/);
  if (agentMatch) {
    for (const part of (agentMatch[1] ?? "").split(",")) {
      const name = part.trim();
      if (name) agentNames.push(name);
    }
    rest = rest.slice(agentMatch[0].length).replace(/^\s+/, "");
  }

  // Drop human-mention metadata prefixes; quote focuses on agent pills + body.
  const humanMatch = rest.match(/^\[Mentioned humans: ([^\]]+)\](?:\r?\n)?/);
  if (humanMatch) {
    rest = rest.slice(humanMatch[0].length).replace(/^\s+/, "");
  }

  // Legacy free-form @mentions at the start of body.
  rest = rest.replace(/^(?:@\S+\s*)+/, "").trim();

  // Strip leftover instruction metadata lines if any.
  rest = rest
    .replace(/\[Mentioned:[^\]]*\|instruction:[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const body =
    rest.length <= maxBodyLen
      ? rest
      : `${rest.slice(0, Math.max(0, maxBodyLen - 1)).trimEnd()}…`;

  return { agentNames, body };
}

/** @deprecated Prefer parseReplyQuoteContent — kept for call sites that only need text. */
export function formatReplyQuoteSnippet(content: string, maxLen = 80): string {
  return parseReplyQuoteContent(content, maxLen).body;
}
