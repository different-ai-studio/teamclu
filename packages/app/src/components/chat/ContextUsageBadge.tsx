import * as React from "react";
import { useSessionStore } from "@/stores/session-store";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Known context window sizes (in tokens) for popular models
const MODEL_CONTEXT_SIZES: Record<string, number> = {
  // Anthropic
  "claude-sonnet-4-20250514": 200_000,
  "claude-sonnet-4-0": 200_000,
  "claude-opus-4-0": 200_000,
  "claude-opus-4-20250514": 200_000,
  "claude-3-5-sonnet-20241022": 200_000,
  "claude-3-5-sonnet": 200_000,
  "claude-3-5-haiku-20241022": 200_000,
  "claude-3-5-haiku": 200_000,
  "claude-3-opus": 200_000,
  "claude-3-sonnet": 200_000,
  "claude-3-haiku": 200_000,
  // OpenAI
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-4": 8_192,
  "o1": 200_000,
  "o1-mini": 128_000,
  "o1-preview": 128_000,
  "o3": 200_000,
  "o3-mini": 200_000,
  "o4-mini": 200_000,
  // Google
  "gemini-2.5-pro": 1_000_000,
  "gemini-2.5-flash": 1_000_000,
  "gemini-2.0-flash": 1_000_000,
  "gemini-1.5-pro": 2_000_000,
  "gemini-1.5-flash": 1_000_000,
  // Deepseek
  "deepseek-chat": 128_000,
  "deepseek-reasoner": 128_000,
};

const DEFAULT_CONTEXT_SIZE = 200_000;

function getContextWindowSize(modelId: string): number {
  // Direct match
  if (MODEL_CONTEXT_SIZES[modelId]) return MODEL_CONTEXT_SIZES[modelId];

  // Fuzzy match: check if the model ID contains a known key
  const lowerModelId = modelId.toLowerCase();
  for (const [key, size] of Object.entries(MODEL_CONTEXT_SIZES)) {
    if (lowerModelId.includes(key.toLowerCase())) return size;
  }

  // Check by prefix patterns
  if (lowerModelId.includes("claude")) return 200_000;
  if (lowerModelId.includes("gpt-4o")) return 128_000;
  if (lowerModelId.includes("gemini")) return 1_000_000;
  if (lowerModelId.includes("deepseek")) return 128_000;

  return DEFAULT_CONTEXT_SIZE;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`;
  return `${tokens}`;
}

/**
 * `modelId` is the session's resolved model (`selectAgentModel`), passed down
 * rather than read from a store: there is no workspace-global "current model"
 * to consult, and sizing the bar off one made the percentage wrong whenever it
 * disagreed with what the session actually ran on. Empty (no agent engaged)
 * falls back to DEFAULT_CONTEXT_SIZE.
 */
export function ContextUsageBadge({ modelId }: { modelId?: string }) {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);

  const { percentage, totalTokens, contextSize } = React.useMemo(() => {
    if (!activeSessionId) return { percentage: 0, totalTokens: 0, contextSize: DEFAULT_CONTEXT_SIZE };

    const session = sessions.find((s) => s.id === activeSessionId);
    if (!session) return { percentage: 0, totalTokens: 0, contextSize: DEFAULT_CONTEXT_SIZE };

    const ctxSize = getContextWindowSize(modelId ?? "");

    // Use the last message's input tokens as the best estimate of current context usage
    // (each message's input tokens includes all prior context)
    const lastAssistantMsg = [...session.messages].reverse().find(
      (m) => m.role === "assistant" && m.tokens
    );
    const currentUsage = lastAssistantMsg?.tokens?.input || 0;

    return {
      percentage: ctxSize > 0 ? Math.min(100, Math.round((currentUsage / ctxSize) * 100)) : 0,
      totalTokens: currentUsage,
      contextSize: ctxSize,
    };
  }, [activeSessionId, sessions, modelId]);

  if (percentage === 0) return null;

  const color =
    percentage >= 90
      ? "text-red-500"
      : percentage >= 70
        ? "text-orange-500"
        : "text-muted-foreground";

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "text-[11px] font-mono tabular-nums select-none cursor-default",
              color,
            )}
          >
            {percentage}%
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          <p>Context: {formatTokenCount(totalTokens)} / {formatTokenCount(contextSize)} tokens</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
