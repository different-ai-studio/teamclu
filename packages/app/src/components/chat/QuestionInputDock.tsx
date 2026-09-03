import * as React from "react";
import { useTranslation } from "react-i18next";
import { Check, CornerDownLeft, ChevronLeft, ChevronRight } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useSessionStore } from "@/stores/session-store";
import type { PendingQuestionState } from "@/stores/session-types";

type QuestionInputAppearance = "overlay" | "stack";

interface QuestionInputDockProps {
  pendingQuestion: PendingQuestionState;
  /** `overlay` floats over the thread; `stack` embeds in ComposerStack. */
  appearance?: QuestionInputAppearance;
  compact?: boolean;
  onHeightChange?: (height: number) => void;
  bottomOffsetPx?: number;
  /** When true, ESC is left to other overlays (e.g. enlarged live panel). */
  disableEscapeShortcut?: boolean;
}

function getOptionValue(option: { label: string; value?: string }) {
  return option.value ?? option.label;
}

function getQuestionId(question: { id?: string }, index: number) {
  return question.id || String(index);
}

const questionMarkdownPlugins = [remarkGfm];

const questionMarkdownComponents = {
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="mb-1.5 mt-2 text-base font-semibold leading-6 text-foreground first:mt-0">{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="mb-1.5 mt-2 text-[15px] font-semibold leading-6 text-foreground first:mt-0">{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="mb-1.5 mt-2 text-sm font-semibold leading-5 text-foreground first:mt-0">{children}</h3>
  ),
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="my-1.5 leading-5 first:mt-0 last:mb-0">{children}</p>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="my-1.5 list-disc space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="my-1.5 list-decimal space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li className="pl-0.5 leading-5">{children}</li>
  ),
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>
  ),
  a: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
    <a className="text-foreground underline underline-offset-2" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  code: ({ className, children }: { className?: string; children?: React.ReactNode }) => {
    const isBlock = !!className;
    if (isBlock) {
      return (
        <code className="block whitespace-pre font-mono text-[12px] leading-5 text-foreground">
          {children}
        </code>
      );
    }

    return (
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.92em] leading-snug text-foreground break-words [overflow-wrap:anywhere]">
        {children}
      </code>
    );
  },
  pre: ({ children }: { children?: React.ReactNode }) => (
    <pre className="my-2 overflow-x-auto rounded-md bg-muted px-3 py-2">{children}</pre>
  ),
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-2 overflow-x-auto rounded-md border border-border first:mt-0 last:mb-0">
      <table className="min-w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border-b border-border bg-muted px-2 py-1.5 text-left font-semibold text-foreground">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border-b border-border px-2 py-1.5 last:border-b-0">{children}</td>
  ),
} as const;

function QuestionMarkdown({ children }: { children: string }) {
  return (
    <div className="mb-3 max-h-72 overflow-y-auto pr-1 text-[13px] leading-5 text-muted-foreground break-words [overflow-wrap:anywhere]">
      <ReactMarkdown
        remarkPlugins={questionMarkdownPlugins}
        components={questionMarkdownComponents}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export function QuestionInputDock({
  pendingQuestion,
  appearance = "overlay",
  compact = false,
  onHeightChange,
  bottomOffsetPx = 0,
  disableEscapeShortcut = false,
}: QuestionInputDockProps) {
  const { t } = useTranslation();
  const answerQuestion = useSessionStore((s) => s.answerQuestion);
  const skipQuestion = useSessionStore((s) => s.skipQuestion);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const lastReportedHeight = React.useRef(0);
  const questions = pendingQuestion.questions;
  const [questionIndex, setQuestionIndex] = React.useState(0);
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [customInputs, setCustomInputs] = React.useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [hasSubmitted, setHasSubmitted] = React.useState(false);

  React.useEffect(() => {
    const el = rootRef.current;
    if (!el || !onHeightChange) return;

    const reportHeight = () => {
      const rounded = Math.round(el.getBoundingClientRect().height);
      if (rounded !== lastReportedHeight.current) {
        lastReportedHeight.current = rounded;
        onHeightChange(rounded);
      }
    };

    reportHeight();
    if (typeof ResizeObserver === "undefined") return;

    const ro = new ResizeObserver(reportHeight);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onHeightChange]);

  React.useEffect(() => {
    setQuestionIndex((value) => Math.min(value, Math.max(questions.length - 1, 0)));
  }, [questions.length]);

  const currentQuestion = questions[questionIndex];
  const currentQuestionId = currentQuestion?.id || String(questionIndex);
  const hasSelectedAnswer = Object.prototype.hasOwnProperty.call(answers, currentQuestionId);
  const selectedAnswer = hasSelectedAnswer ? answers[currentQuestionId] : "";
  const customAnswer = customInputs[currentQuestionId] || "";
  const trimmedCustomAnswer = customAnswer.trim();
  const isLastQuestion = questionIndex >= questions.length - 1;
  const canContinue =
    (!!trimmedCustomAnswer || hasSelectedAnswer) &&
    !!pendingQuestion.questionId &&
    !isSubmitting &&
    !hasSubmitted;
  const canSkip = !!pendingQuestion.questionId && !isSubmitting && !hasSubmitted;
  const questionTitle = currentQuestion?.header || t("chat.toolCall.question.title", "Question");

  const hasAnswerForQuestion = React.useCallback((question: { id?: string }, index: number) => {
    const questionId = getQuestionId(question, index);
    return !!customInputs[questionId]?.trim() || Object.prototype.hasOwnProperty.call(answers, questionId);
  }, [answers, customInputs]);

  const buildFinalAnswers = React.useCallback(() => {
    const finalAnswers: Record<string, string> = {};
    questions.forEach((question, index) => {
      const questionId = getQuestionId(question, index);
      const custom = customInputs[questionId]?.trim();
      finalAnswers[questionId] = custom || (answers[questionId] ?? "");
    });
    return finalAnswers;
  }, [answers, customInputs, questions]);

  const shouldSubmitEmptyAnswerOnSkip = React.useMemo(
    () =>
      isLastQuestion &&
      questions.length > 1 &&
      questions.slice(0, -1).every(hasAnswerForQuestion) &&
      !!currentQuestion?.options?.some((option: any) => getOptionValue(option) === ""),
    [currentQuestion?.options, hasAnswerForQuestion, isLastQuestion, questions],
  );

  const handleOptionSelect = (value: string) => {
    setAnswers((prev) => ({ ...prev, [currentQuestionId]: value }));
    setCustomInputs((prev) => ({ ...prev, [currentQuestionId]: "" }));
    if (!isLastQuestion) {
      setQuestionIndex((index) => Math.min(index + 1, questions.length - 1));
    }
  };

  const handleCustomInput = (value: string) => {
    setCustomInputs((prev) => ({ ...prev, [currentQuestionId]: value }));
  };

  const handleContinue = async () => {
    if (!canContinue) return;
    if (!isLastQuestion) {
      setQuestionIndex((value) => Math.min(value + 1, questions.length - 1));
      return;
    }

    setIsSubmitting(true);
    try {
      await answerQuestion(buildFinalAnswers(), pendingQuestion.questionId);
      setHasSubmitted(true);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSkip = React.useCallback(async () => {
    if (!canSkip) return;
    setIsSubmitting(true);
    try {
      if (shouldSubmitEmptyAnswerOnSkip) {
        const finalAnswers = buildFinalAnswers();
        finalAnswers[currentQuestionId] = "";
        await answerQuestion(finalAnswers, pendingQuestion.questionId);
      } else {
        await skipQuestion(pendingQuestion.questionId);
      }
      setHasSubmitted(true);
    } finally {
      setIsSubmitting(false);
    }
  }, [
    answerQuestion,
    buildFinalAnswers,
    canSkip,
    currentQuestionId,
    pendingQuestion.questionId,
    shouldSubmitEmptyAnswerOnSkip,
    skipQuestion,
  ]);

  React.useEffect(() => {
    if (disableEscapeShortcut) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !canSkip) return;
      event.preventDefault();
      void handleSkip();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canSkip, disableEscapeShortcut, handleSkip]);

  if (!currentQuestion) return null;

  const isStack = appearance === "stack";

  const questionSection = (
        <section
          className={cn(
            "relative z-10 overflow-hidden",
            isStack
              ? "border-t border-border/50 bg-paper"
              : "rounded-[20px] border border-border/70 bg-card shadow-[0_18px_44px_rgba(15,23,42,0.12)]",
          )}
        >
          <div
            className={cn(
              "flex items-center justify-between gap-4",
              isStack ? "px-3.5 pb-1 pt-3" : "px-4 pb-1 pt-3",
            )}
          >
            <div className="min-w-0 flex items-center gap-2">
              {isStack ? (
                <span className="shrink-0 rounded border border-coral/35 px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-wide text-coral">
                  {t("chat.toolCall.question.title", "Question")}
                </span>
              ) : null}
              <div className="truncate text-[15px] font-semibold leading-5 text-foreground">
                {questionTitle}
              </div>
            </div>
            {questions.length > 1 ? (
              <div className="flex shrink-0 items-center gap-2 text-xs font-medium text-muted-foreground">
                <button
                  type="button"
                  aria-label={t("common.previous", "Previous")}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-full hover:text-foreground disabled:opacity-35"
                  disabled={questionIndex === 0}
                  onClick={() => setQuestionIndex((value) => Math.max(value - 1, 0))}
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="min-w-10 text-center text-xs font-semibold">{questionIndex + 1} of {questions.length}</span>
                <button
                  type="button"
                  aria-label={t("common.next", "Next")}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-full hover:text-foreground disabled:opacity-35"
                  disabled={questionIndex === questions.length - 1}
                  onClick={() => setQuestionIndex((value) => Math.min(value + 1, questions.length - 1))}
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            ) : null}
          </div>

          <div className={cn(isStack ? "px-3.5 pb-3 pt-2" : "px-4 pb-3 pt-3")}>
            <QuestionMarkdown>{currentQuestion.question ?? ""}</QuestionMarkdown>

            <div className="space-y-1">
              {currentQuestion.options?.map((option: any, optionIndex: number) => {
                const optionValue = getOptionValue(option);
                const isSelected = hasSelectedAnswer && selectedAnswer === optionValue && !customAnswer.trim();
                return (
                  <button
                    key={`${optionValue}-${optionIndex}`}
                    type="button"
                    onClick={() => handleOptionSelect(optionValue)}
                    disabled={isSubmitting || hasSubmitted}
                    className={cn(
                      "grid min-h-9 w-full grid-cols-[2rem_minmax(0,1fr)_1.5rem] items-center gap-2 rounded-[12px] px-2.5 text-left transition-colors",
                      isSelected
                        ? "bg-muted text-foreground"
                        : "text-foreground hover:bg-muted/45",
                    )}
                  >
                    <span className="text-[13px] font-semibold text-muted-foreground/85">{optionIndex + 1}.</span>
                    <span className="min-w-0 truncate text-sm font-semibold">
                      {option.label}
                      {optionIndex === 0 ? (
                        <span className="ml-2 rounded-full border border-border/70 bg-background px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                          {t("common.recommended", "Recommended")}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex justify-end">
                      {isSelected ? <Check className="h-4 w-4 text-foreground/65" /> : null}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="mt-1 grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
              <div className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] items-center gap-2 rounded-[12px] px-2.5 hover:bg-muted/30">
                <span className="text-[13px] font-semibold text-muted-foreground/85">
                  {(currentQuestion.options?.length || 0) + 1}.
                </span>
                <Input
                  value={customAnswer}
                  onChange={(event) => handleCustomInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void handleContinue();
                    }
                  }}
                  disabled={isSubmitting || hasSubmitted}
                  placeholder={
                    currentQuestion.options?.length
                      ? t("chat.toolCall.question.customAnswerPlaceholder", "Or type a custom answer...")
                      : t("chat.toolCall.question.answerPlaceholder", "Type your answer...")
                  }
                  className="h-9 min-w-0 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
                />
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleSkip()}
                  disabled={!canSkip}
                  className="whitespace-nowrap text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  {t("common.skip", "Skip")} <kbd className="ml-1 rounded-md bg-muted px-1.5 py-[1px] text-[10px] font-semibold text-foreground/70">ESC</kbd>
                </button>
                <Button
                  type="button"
                  onClick={() => void handleContinue()}
                  disabled={!canContinue}
                  className={cn(
                    "h-7 shrink-0 whitespace-nowrap px-3 text-xs font-semibold shadow-sm disabled:opacity-40",
                    isStack
                      ? "rounded-lg bg-coral text-white hover:bg-coral/90"
                      : "rounded-full bg-[#111111] text-white hover:bg-[#262626] disabled:bg-[#111111]/45 disabled:text-white/75 dark:bg-[#f4f4f5] dark:text-[#18181b] dark:hover:bg-white dark:disabled:bg-[#f4f4f5]/45 dark:disabled:text-[#18181b]/70",
                  )}
                >
                  <CornerDownLeft className="h-2.5 w-2.5" />
                  {isSubmitting
                    ? t("chat.toolCall.question.submitting", "Submitting...")
                    : isLastQuestion
                      ? t("chat.toolCall.question.submitAnswer", "Submit Answer")
                      : t("common.continue", "Continue")}
                </Button>
              </div>
            </div>
          </div>
        </section>
  );

  if (isStack) {
    return (
      <div ref={rootRef} data-testid="question-input-dock" data-appearance="stack">
        {questionSection}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      data-testid="question-input-dock"
      data-appearance="overlay"
      style={bottomOffsetPx ? { bottom: bottomOffsetPx } : undefined}
      className={cn(
        "z-10",
        compact
          ? "absolute bottom-0 left-0 right-0 px-2 pb-2 pt-2 bg-background"
          : "absolute bottom-0 left-0 right-0 px-4 pb-4 pt-5",
      )}
    >
      <div className={cn("relative w-full", compact ? "" : "mx-auto max-w-[46rem]")}>
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute left-[-1px] right-[-1px] top-0 bottom-[-1.75rem] bg-background",
            compact && "hidden",
          )}
        />
        {questionSection}
      </div>
    </div>
  );
}
