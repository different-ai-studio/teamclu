import { useState, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useTabsStore, Tab } from "@/stores/tabs";
import { cn } from "@/lib/utils";
import { X, Code, Globe, LayoutDashboard, FileText, Image, Sparkles, Plug, Box, History } from "lucide-react";
import {
  decodeTeamShareTarget,
  decodeVersionHistoryTarget,
} from "@/lib/tabs/teamshare-target";

function getTabIcon(tab: Tab) {
  if (tab.type === "webview") return Globe;
  if (tab.type === "native") {
    // Native tabs are no longer one kind of thing. Without this they all wear
    // the same generic icon, and a strip holding a skill, an MCP server and a
    // file's history reads as three copies of the same tab.
    const teamShare = decodeTeamShareTarget(tab.target);
    if (teamShare) {
      if (teamShare.kind === "skill") return Sparkles;
      if (teamShare.kind === "skill-file") return Code;
      if (teamShare.kind === "mcp") return Plug;
      if (teamShare.kind === "env") return Box;
      return LayoutDashboard;
    }
    if (decodeVersionHistoryTarget(tab.target) !== undefined) return History;
    return LayoutDashboard;
  }
  const ext = tab.target.split(".").pop()?.toLowerCase() || "";
  const codeExts = [
    "ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "c", "cpp", "h",
    "css", "scss", "html", "json", "yaml", "yml", "toml", "xml", "md",
    "sh", "bash", "zsh", "vue", "svelte",
  ];
  const imageExts = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"];
  if (codeExts.includes(ext)) return Code;
  if (imageExts.includes(ext)) return Image;
  return FileText;
}

interface ContextMenuState {
  tabId: string;
  x: number;
  y: number;
}

export function TabBar() {
  const { t } = useTranslation();
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const setActiveTab = useTabsStore((s) => s.setActiveTab);
  const closeTab = useTabsStore((s) => s.closeTab);
  const closeOthers = useTabsStore((s) => s.closeOthers);
  const closeAll = useTabsStore((s) => s.closeAll);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    e.stopPropagation();
    // Use nativeEvent.stopImmediatePropagation to prevent the window-level
    // contextmenu listener (from a previous menu) from dismissing this one
    e.nativeEvent.stopImmediatePropagation();
    setContextMenu({ tabId, x: e.clientX, y: e.clientY });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  // Close context menu on any click/right-click outside, or Escape
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") dismiss(); };
    window.addEventListener("mousedown", dismiss);
    window.addEventListener("contextmenu", dismiss);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", dismiss);
      window.removeEventListener("contextmenu", dismiss);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

  if (tabs.length === 0 || !activeTabId) return null;

  return (
    <div
      className="flex items-center overflow-x-auto border-b bg-muted/30 shrink-0"
      role="tablist"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const Icon = getTabIcon(tab);
        return (
          <div
            key={tab.id}
            role="tab"
            data-active={isActive}
            className={cn(
              "group relative flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer border-r border-border shrink-0 max-w-[180px]",
              "transition-colors duration-150",
              isActive
                ? "bg-background text-foreground font-medium shadow-[inset_0_-2px_0_0_hsl(var(--primary))]"
                : "text-muted-foreground hover:bg-background/50 hover:text-foreground",
            )}
            onClick={() => setActiveTab(tab.id)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeTab(tab.id);
              }
            }}
            onContextMenu={(e) => handleContextMenu(e, tab.id)}
          >
            {tab.type === "webview" && tab.faviconUrl ? (
              <img
                src={tab.faviconUrl}
                className="h-3.5 w-3.5 shrink-0"
                alt=""
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                  (e.target as HTMLImageElement).nextElementSibling?.classList.remove("hidden");
                }}
              />
            ) : null}
            <Icon className={cn("h-3.5 w-3.5 shrink-0", tab.type === "webview" && tab.faviconUrl && "hidden")} />
            <span className="truncate">{(tab.type === "webview" && tab.title) || tab.label}</span>
            {tab.dirty && (
              <span className="w-2 h-2 rounded-full bg-primary shrink-0" data-dirty="true" />
            )}
            <button
              aria-label={t('tabBar.closeAria', 'Close tab')}
              className={cn(
                "ml-auto p-0.5 rounded hover:bg-muted shrink-0",
                isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100",
              )}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}

      {contextMenu && createPortal(
        <div
          className="fixed z-[9999] bg-popover border rounded-md shadow-lg py-1 text-xs min-w-[120px]"
          style={{ left: contextMenu.x, bottom: `calc(100vh - ${contextMenu.y}px)` }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="w-full px-3 py-1.5 text-left hover:bg-muted"
            onClick={() => { closeTab(contextMenu.tabId); closeContextMenu(); }}
          >
            Close
          </button>
          <button
            className="w-full px-3 py-1.5 text-left hover:bg-muted"
            onClick={() => { closeOthers(contextMenu.tabId); closeContextMenu(); }}
          >
            Close Others
          </button>
          <button
            className="w-full px-3 py-1.5 text-left hover:bg-muted"
            onClick={() => { closeAll(); closeContextMenu(); }}
          >
            Close All
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
