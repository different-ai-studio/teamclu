import * as React from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Brain } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useStreamRevealText } from "@/hooks/use-stream-reveal-text";

interface ThinkingBlockProps {
  content: string;
  isStreaming?: boolean;
  isOpen?: boolean;
}

export const ThinkingBlock = React.memo(function ThinkingBlock({
  content,
  isStreaming = false,
  isOpen = false,
}: ThinkingBlockProps) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(isOpen);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const revealedContent = useStreamRevealText(content, isStreaming);

  React.useEffect(() => {
    if (!isStreaming) setOpen(isOpen);
  }, [isOpen, isStreaming]);

  React.useEffect(() => {
    if (isStreaming && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [isStreaming, revealedContent]);

  const compactContent = React.useMemo(
    () => revealedContent.replace(/\n{2,}/g, "\n"),
    [revealedContent],
  );

  if (isStreaming) {
    return (
      <div className="my-1">
        <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
          <div className="relative">
            <Brain className="h-3.5 w-3.5 text-emerald-500" />
            <span className="absolute -top-0.5 -right-0.5 h-2 w-2">
              <span className="absolute inset-0 rounded-full bg-emerald-500 animate-ping opacity-75" />
              <span className="relative block h-2 w-2 rounded-full bg-emerald-500" />
            </span>
          </div>
          <span className="font-medium">
            {t("chat.thinking", "Thinking...")}
          </span>
        </div>
        {compactContent && (
          <div
            ref={scrollRef}
            className="mt-1 rounded-lg border border-border/50 bg-muted/20 overflow-hidden"
            style={{ maxHeight: "4.8em" }}
          >
            <pre className="whitespace-pre-wrap font-mono text-xs text-muted-foreground leading-tight px-3 py-2">
              {compactContent}
            </pre>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="my-0.5">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button className="flex items-center gap-2 px-2 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors">
            <Brain className="h-3.5 w-3.5" />
            <span className="font-medium">
              {t("chat.thinkingProcess", "Thinking Process")}
            </span>
            <ChevronDown
              className={`h-3 w-3 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-1.5">
          <div className="rounded-lg border border-border/50 bg-muted/20 p-3 text-xs text-muted-foreground">
            <pre className="whitespace-pre-wrap font-mono leading-snug">
              {content}
            </pre>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
});
