import * as React from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function MessageActionIconButton({
  label,
  onClick,
  testId,
  active = false,
  children,
}: {
  label: string;
  onClick?: () => void;
  testId?: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          onClick={onClick}
          aria-label={label}
          className={cn(
            "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors",
            "hover:bg-muted/40 hover:text-foreground",
            active && "bg-selected text-ink-2",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
