//! Small pieces of the window chrome: the terminal toggle button, one
//! header tab, and the drag handle between panes.

import { useState, useRef, MouseEvent as ReactMouseEvent, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { TerminalSquare } from "lucide-react";
import { useTerminalStore } from "@/stores/terminal-store";

/** Terminal toggle button in the header. */
export function TerminalToggleButton({ workspacePath }: { workspacePath: string }) {
  const { t } = useTranslation();
  const terminalOpen = useTerminalStore(
    s => Boolean(s.panelOpenByWorkspace[workspacePath]),
  );
  const togglePanel = useTerminalStore(s => s.togglePanel);
  return (
    <button
      className={cn(
        "ml-1 rounded p-1 transition-colors hover:bg-muted hover:text-foreground",
        terminalOpen ? "bg-muted text-foreground" : "text-muted-foreground",
      )}
      onClick={() => togglePanel(workspacePath)}
      title={t("terminal.toggle", "Toggle terminal (⌃`)")}
    >
      <TerminalSquare className="h-4 w-4" />
    </button>
  );
}

// Header panel tab button component
export function HeaderPanelTab({
  icon: Icon,
  label,
  count,
  isActive,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  count?: number;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`flex items-center gap-1.5 px-2 py-1 text-xs transition-colors rounded ${
        isActive
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-muted"
      }`}
      onClick={onClick}
    >
      <Icon className="h-4 w-4" />
      {isActive && <span>{label}</span>}
      {!!count && count > 0 && (
        <span
          className={`min-w-[1.25rem] h-5 px-1 rounded-full text-[10px] font-medium flex items-center justify-center ${
            isActive ? "bg-primary/20 text-primary" : "bg-muted-foreground/20"
          }`}
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </button>
  );
}

// Resize handle component for resizable panels
export function ResizeHandle({
  onResize,
  direction = "horizontal",
  className = "",
  testId,
}: {
  onResize: (delta: number) => void;
  direction?: "horizontal" | "vertical";
  className?: string;
  testId?: string;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const startPosRef = useRef(0);

  const handleMouseDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    startPosRef.current = direction === "horizontal" ? e.clientX : e.clientY;

    const handleMouseMove = (moveEvent: globalThis.MouseEvent) => {
      const currentPos =
        direction === "horizontal" ? moveEvent.clientX : moveEvent.clientY;
      const delta = currentPos - startPosRef.current;
      startPosRef.current = currentPos;
      onResize(delta);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor =
      direction === "horizontal" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div
      className={`
        ${direction === "horizontal" ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize"}
        ${isDragging ? "bg-primary" : "bg-transparent hover:bg-primary/50"}
        transition-colors duration-150 flex-shrink-0 z-20
        ${className}
      `}
      data-testid={testId}
      onMouseDown={handleMouseDown}
    >
      {/* Larger hit area */}
      <div
        className={`
          ${direction === "horizontal" ? "w-3 h-full -ml-1" : "h-3 w-full -mt-1"}
        `}
      />
    </div>
  );
}

