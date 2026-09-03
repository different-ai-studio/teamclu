import * as React from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Clock3, ListTodo, Trash2 } from "lucide-react";
import { type Todo, type QueuedMessage } from "@/stores/session-types";
import { cn } from "@/lib/utils";
import {
  composerGlassSurfaceClass,
  composerStackRowDividerClass,
} from "./composer-glass";

const planListScrollbarClass =
  "[scrollbar-width:thin] [scrollbar-color:rgba(113,113,122,0.42)_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/35";

/** Neutral gray — avoid warm --selected / --foreground tints on paper. */
const planRowHoverClass = "hover:bg-black/[0.04] dark:hover:bg-white/[0.06]";

function planStatusDotClass(status: Todo["status"]): string {
  if (status === "in_progress") {
    return "border-coral bg-coral-soft";
  }
  if (status === "completed") {
    return "border-[#2eb872] bg-[#2eb872]";
  }
  return "border-faint";
}

function priorityLabel(priority: Todo["priority"] | undefined): string {
  if (priority === "high") return "high";
  if (priority === "low") return "low";
  return "med";
}

export function ComposerPlanSlot({
  todos,
  queue,
  onRemoveFromQueue,
  roundsTop = false,
  hidden = false,
}: {
  todos: Todo[];
  queue: QueuedMessage[];
  onRemoveFromQueue?: (id: string) => void;
  /** When plan is the top row of the stack, clip header hover/focus to shell radius. */
  roundsTop?: boolean;
  /** Keep mounted (preserve collapse) but hide during approval overlay. */
  hidden?: boolean;
}) {
  const { t } = useTranslation();
  const completedCount = todos.filter((todo) => todo.status === "completed").length;
  const allCompleted = todos.length > 0 && completedCount === todos.length;
  const [planCollapsed, setPlanCollapsed] = React.useState(allCompleted);
  const [queueCollapsed, setQueueCollapsed] = React.useState(false);
  const prevTodoCountRef = React.useRef(0);
  const prevInProgressCountRef = React.useRef(0);

  const hasTodos = todos.length > 0;
  const hasQueue = queue.length > 0;

  React.useEffect(() => {
    if (!hasTodos) {
      prevTodoCountRef.current = 0;
      prevInProgressCountRef.current = 0;
      return;
    }

    const inProgressCount = todos.filter((todo) => todo.status === "in_progress").length;

    if (allCompleted) {
      setPlanCollapsed(true);
      prevTodoCountRef.current = todos.length;
      prevInProgressCountRef.current = inProgressCount;
      return;
    }

    const shouldExpand =
      prevTodoCountRef.current > 0 &&
      (todos.length > prevTodoCountRef.current ||
        inProgressCount > prevInProgressCountRef.current);

    if (shouldExpand) {
      setPlanCollapsed(false);
    }

    prevTodoCountRef.current = todos.length;
    prevInProgressCountRef.current = inProgressCount;
  }, [allCompleted, hasTodos, todos]);

  if (!hasTodos && !hasQueue) return null;

  return (
    <section
      data-testid="composer-plan-slot"
      className={cn(
        "box-border w-full",
        composerGlassSurfaceClass,
        composerStackRowDividerClass,
        roundsTop && "overflow-hidden rounded-t-[14px]",
        hidden && "hidden",
      )}
    >
      {hasTodos ? (
        <>
          <button
            type="button"
            data-testid="todo-list-inline"
            className={cn(
              "flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left transition-colors outline-none",
              planRowHoverClass,
              "focus-visible:bg-black/[0.04] dark:focus-visible:bg-white/[0.06]",
              roundsTop && "rounded-t-[14px]",
            )}
            aria-expanded={!planCollapsed}
            onClick={() => setPlanCollapsed((value) => !value)}
          >
            <ListTodo className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 text-[12px] font-medium text-ink-2">
              {t("chat.todo.stackSummary", "{{count}} 项任务 · {{completed}} 已完成", {
                count: todos.length,
                completed: completedCount,
              })}
            </span>
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-faint transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]",
                planCollapsed && "-rotate-90",
              )}
              aria-hidden
            />
          </button>

          <div
            data-testid="todo-list-inline-scroll-shell"
            className={cn(
              "grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
              planCollapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
            )}
            aria-hidden={planCollapsed}
          >
            <div className="min-h-0 overflow-hidden">
              <div
                data-testid="todo-list-inline-scroll"
                className={cn("max-h-[7.5rem] overflow-y-auto px-3 pb-2", planListScrollbarClass)}
              >
                {todos.map((todo, index) => (
                  <div
                    key={todo.id}
                    className={cn(
                      "grid grid-cols-[14px_1fr_auto] items-center gap-2 rounded-md px-1 py-[5px]",
                      planRowHoverClass,
                    )}
                  >
                    <span
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full border-[1.5px]",
                        planStatusDotClass(todo.status),
                      )}
                      aria-hidden
                    />
                    <span
                      className={cn(
                        "min-w-0 truncate text-[12px] leading-[1.45] text-foreground",
                        todo.status === "completed" && "text-muted-foreground line-through",
                      )}
                    >
                      {index + 1}. {todo.content}
                    </span>
                    <span className="font-mono text-[9.5px] uppercase text-faint">
                      {priorityLabel(todo.priority)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      ) : null}

      {hasQueue ? (
        <section data-testid="todo-list-inline-queue" className="border-t border-border">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-muted-foreground"
            aria-expanded={!queueCollapsed}
            onClick={() => setQueueCollapsed((value) => !value)}
          >
            <Clock3 className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="flex-1">
              {t("chat.messagesQueued", "{{count}} messages queued", { count: queue.length })}
            </span>
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-faint transition-transform duration-200",
                queueCollapsed && "-rotate-90",
              )}
              aria-hidden
            />
          </button>
          <div
            data-testid="todo-list-inline-queue-shell"
            className={cn(
              "grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
              queueCollapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
            )}
            aria-hidden={queueCollapsed}
          >
            <div className="min-h-0 overflow-hidden">
              <div
                data-testid="todo-list-inline-queue-body"
                className={cn(
                  "max-h-[8.5rem] space-y-1.5 overflow-y-auto px-3 pb-2.5",
                  planListScrollbarClass,
                )}
              >
                {queue.map((msg, index) => (
                  <div
                    key={msg.id}
                    className="group flex items-center gap-3 text-[13px] leading-5 text-foreground"
                  >
                    <span className="w-5 shrink-0 font-mono text-xs text-muted-foreground">
                      {index + 1}.
                    </span>
                    <span className="min-w-0 flex-1 truncate">{msg.content}</span>
                    {onRemoveFromQueue ? (
                      <button
                        type="button"
                        onClick={() => onRemoveFromQueue(msg.id)}
                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                        title={t("common.remove", "Remove")}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      ) : null}
    </section>
  );
}
