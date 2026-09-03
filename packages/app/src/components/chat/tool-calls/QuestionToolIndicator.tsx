import { HelpCircle, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ToolCall } from "@/stores/session-types";

function getQuestionCount(toolCall: ToolCall): number {
  if (Array.isArray(toolCall.questions)) return toolCall.questions.length;
  const args = toolCall.arguments as { questions?: unknown } | undefined;
  return Array.isArray(args?.questions) ? args.questions.length : 0;
}

export function QuestionToolIndicator({ toolCall }: { toolCall: ToolCall }) {
  const { t } = useTranslation();
  const questionCount = getQuestionCount(toolCall);
  const isQuestionLoading =
    questionCount === 0 &&
    (toolCall.status === "calling" || toolCall.status === "waiting");
  const questionCountText = t(
    questionCount === 1
      ? "chat.toolCall.question.countOne"
      : "chat.toolCall.question.count",
    questionCount === 1 ? "{{count}} question" : "{{count}} questions",
    { count: questionCount },
  );

  return (
    <div
      data-testid="tool-row-question"
      className="flex items-center gap-1.5 px-[10px] py-[4px] text-[12px] text-muted-foreground"
    >
      <HelpCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="font-medium text-foreground/80">
        {t("chat.toolCall.question.title", "Question")}
      </span>
      {questionCount > 0 ? (
        <>
          <span className="text-muted-foreground">·</span>
          <span>{questionCountText}</span>
        </>
      ) : null}
      {isQuestionLoading ? (
        <Loader2
          data-testid="question-tool-loading"
          className="h-3 w-3 animate-spin text-muted-foreground"
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}
