import { cn } from "@/lib/utils";
import { useActorDisplayName, useAgentModelByActor } from "@/hooks/use-actor-display-name";

/** Subtle "actor name [· model]" label rendered above each message bubble.
 * Right-aligned for user messages, left-aligned for assistant. Skipped
 * when no senderActorId is available (legacy v1 messages).
 * Model slides out left→right on hover; slides back on leave. */
export function ActorLabel({
  senderActorId,
  modelOverride,
  isUser,
  nameOverride,
}: {
  senderActorId: string | undefined;
  modelOverride?: string | undefined;
  isUser: boolean;
  /** Display-only label override (e.g. localized "你"). */
  nameOverride?: string;
}) {
  const name = useActorDisplayName(senderActorId);
  const displayName = nameOverride ?? name;
  // Prefer the model captured on the message itself (historically accurate);
  // fall back to the runtime's live currentModel when the message predates
  // the model column or wasn't stamped.
  const liveModel = useAgentModelByActor(isUser ? null : senderActorId);
  const model = modelOverride || liveModel;
  if (!senderActorId || !displayName) return null;
  return (
    <div
      className={cn(
        "group/actor-label mb-0.5 flex items-baseline px-1 text-[11px] text-muted-foreground/70",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      <span className="shrink-0">{displayName}</span>
      {!isUser && model ? (
        <span
          className={cn(
            "inline-grid min-w-0 transition-[grid-template-columns] duration-200 ease-out",
            "grid-cols-[0fr]",
            "group-hover/actor-label:grid-cols-[1fr]",
            "group-hover/msg:grid-cols-[1fr]",
            "group-focus-within/msg:grid-cols-[1fr]",
          )}
        >
          <span className="min-w-0 overflow-hidden">
            <span
              className={cn(
                "inline-block whitespace-nowrap will-change-transform",
                "-translate-x-1.5 opacity-0 transition-[transform,opacity] duration-200 ease-out",
                "group-hover/actor-label:translate-x-0 group-hover/actor-label:opacity-100",
                "group-hover/msg:translate-x-0 group-hover/msg:opacity-100",
                "group-focus-within/msg:translate-x-0 group-focus-within/msg:opacity-100",
              )}
            >
              {" · "}
              {model}
            </span>
          </span>
        </span>
      ) : null}
    </div>
  );
}
